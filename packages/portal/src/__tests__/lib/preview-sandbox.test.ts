/**
 * Preview isolation. render-preview.ts serves customer HTML from the portal's
 * own origin, next to the session cookie — so anything that executes there
 * runs with the viewer's portal authority. The viewer may be a user of an org
 * the site was merely shared into, or a platform operator whose session
 * reaches /api/internal-admin/* across every tenant.
 *
 * The mitigation is a `sandbox` CSP without allow-same-origin (opaque origin:
 * scripts still run, but can't touch portal cookies/DOM), applied to every
 * preview surface. Editor interactions use a narrow postMessage bridge, so
 * the parent never needs same-origin contentDocument access.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import {
  PREVIEW_SANDBOX,
  isolatedPreviewHeaders,
  publicRequestOrigin,
} from '../../lib/preview-headers';

const fakeCookies = { get: () => undefined } as never;
const PREVIEW_FRAME = 'frame=1&bridge=12345678-1234-1234-1234-123456789abc';

describe('PREVIEW_SANDBOX directive', () => {
  it('uses the forwarded public scheme for preview bridge origin binding', () => {
    expect(publicRequestOrigin(new Request('http://app.typeroll.com/preview/site', {
      headers: { 'x-forwarded-proto': 'https' },
    }))).toBe('https://app.typeroll.com');

    expect(publicRequestOrigin(new Request('http://app.typeroll.com/preview/site', {
      headers: { 'x-forwarded-proto': 'https, http' },
    }))).toBe('https://app.typeroll.com');

    expect(publicRequestOrigin(new Request('http://localhost/preview/site', {
      headers: { 'x-forwarded-proto': 'javascript' },
    }))).toBe('http://localhost');
  });

  it('never grants allow-same-origin', () => {
    // The single mistake that turns this whole mitigation into a no-op:
    // `sandbox allow-scripts allow-same-origin` hands back exactly the
    // access the header exists to remove, while still reading as "sandboxed"
    // to anyone skimming the route.
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX.startsWith('sandbox')).toBe(true);
  });

  it('keeps scripts runnable so the preview stays faithful', () => {
    // Dropping allow-scripts would "fix" the threat by making every preview
    // lie about what the live site does. Isolation, not lobotomy.
    expect(PREVIEW_SANDBOX).toContain('allow-scripts');
  });

  it('marks isolated previews no-store and noindex', () => {
    const h = isolatedPreviewHeaders();
    expect(h['Content-Security-Policy']).toBe(PREVIEW_SANDBOX);
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['X-Robots-Tag']).toContain('noindex');
  });
});

describe('token-authed preview route', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    process.env.PREVIEW_HMAC_SECRET = 'x'.repeat(48);
  });

  it('sandboxes even its error responses', async () => {
    // Error bodies are HTML too, and this route is reachable by anyone
    // holding a link — including a logged-in portal user who was sent one.
    const { GET } = await import('../../pages/preview/[siteId]/[...slug]');
    const res = await GET({
      params: { siteId: 'mysite', slug: 'anything' },
      request: new Request('https://app.typeroll.com/preview/mysite/anything'),
    } as never);
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Security-Policy')).toBe(PREVIEW_SANDBOX);
  });

  it('keeps a successfully rendered page in an opaque child of the trusted storage shell', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
    });
    await store.setDoc(paths.page('default', 'mysite', 'home'), {
      title: 'Home', slug: 'home', status: 'published',
      content_mode: 'html', html_content: '<h1>Hello</h1>',
    });

    const { signPreviewTicket } = await import('../../lib/preview-signing');
    const { token } = signPreviewTicket({
      orgId: 'default', siteId: 'mysite', versionId: 'main', ttlSeconds: 300,
    });

    const { GET } = await import('../../pages/preview/[siteId]/[...slug]');
    const outer = await GET({
      params: { siteId: 'mysite', slug: 'home' },
      request: new Request(
        `https://app.typeroll.com/preview/mysite/home?t=${encodeURIComponent(token)}`,
      ),
    } as never);
    expect(outer.status).toBe(200);
    expect(outer.headers.get('Content-Security-Policy')).toContain("frame-src 'self'");
    const shell = await outer.text();
    expect(shell).toContain('sandbox="allow-scripts allow-forms allow-popups"');
    expect(shell).not.toContain('allow-same-origin');
    expect(shell).not.toContain('<h1>Hello</h1>');
    expect(shell).toContain('sessionStorage');
    expect(shell).toContain('typeroll.extension-preview');
    expect(shell).not.toContain('window.name');
    const shellScript = shell.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(shellScript).toBeTruthy();
    expect(() => new Function(shellScript!)).not.toThrow();

    const inner = await GET({
      params: { siteId: 'mysite', slug: 'home' },
      request: new Request(
        `https://app.typeroll.com/preview/mysite/home?t=${encodeURIComponent(token)}&frame=1&bridge=12345678-1234-1234-1234-123456789abc`,
      ),
    } as never);
    expect(inner.status).toBe(200);
    expect(inner.headers.get('Content-Security-Policy')).toBe(PREVIEW_SANDBOX);
    const innerHtml = await inner.text();
    expect(innerHtml).toContain('<h1>Hello</h1>');
    expect(innerHtml).toContain('data-preview-navigation-bridge="1"');
  });
});

describe('editor canvas never runs block JS', () => {
  // The escalation this closes, which an ownership check did NOT: block
  // content needs only `write`, so an `editor` can put JS in a core/embed
  // block. The editor canvas is now opaque-origin and uses postMessage for
  // inline editing and block drag-and-drop. Third-party Extension code gets
  // a second nested opaque frame and cannot impersonate that bridge.
  const EMBED_JS = 'window.__ran = 1';

  const seedPage = async (orgId: string, siteId: string) => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(orgId, siteId), {
      name: 'S', hosting_adapter: 'cloudflare',
    });
    await store.setDoc(paths.page(orgId, siteId, 'home'), {
      title: 'Home', slug: 'home', status: 'published', content_mode: 'blocks',
      blocks: [{ id: 'blk_e', type: 'core/embed', data: { html: '<p>x</p>', js: EMBED_JS } }],
    });
  };

  const browse = async (query: string) => {
    const { GET } = await import(
      '../../pages/api/sites/[siteId]/preview/browse/[...slug]'
    );
    return GET({
      cookies: fakeCookies, params: { siteId: 'mysite', slug: 'home' }, locals: {},
      request: new Request(`https://app.typeroll.com/x${query}`),
    } as never);
  };

  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    await seedPage('default', 'mysite');
  });

  it('withholds the JS in the editor canvas even from the owning org', async () => {
    const html = await (await browse('?embed=1')).text();
    expect(html).toContain('<p>x</p>');   // markup still renders
    expect(html).not.toContain(EMBED_JS); // the code does not
  });

  it('still runs it on the sandboxed preview, so fidelity is one click away', async () => {
    // Publish ▾ → Preview. Opaque origin, so the script has no portal access
    // to abuse and the author can verify their work.
    const res = await browse(`?${PREVIEW_FRAME}`);
    expect(res.headers.get('Content-Security-Policy')).toBe(PREVIEW_SANDBOX);
    expect(await res.text()).toContain(EMBED_JS);
  });

  it("runs it on the chat's draft links too — also sandboxed", async () => {
    const res = await browse(`?draft=1&${PREVIEW_FRAME}`);
    expect(res.headers.get('Content-Security-Policy')).toBe(PREVIEW_SANDBOX);
    expect(await res.text()).toContain(EMBED_JS);
  });

  it('withholds it from the single-page editor preview route as well', async () => {
    const { GET } = await import('../../pages/api/sites/[siteId]/preview/[pageId]');
    const res = await GET({
      cookies: fakeCookies, params: { siteId: 'mysite', pageId: 'home' }, locals: {},
      request: new Request('https://app.typeroll.com/api/sites/mysite/preview/home?canvas=canvas-test-preview1'),
    } as never);
    expect(await res.text()).not.toContain(EMBED_JS);
  });
});

describe('browse preview route — per-mode isolation', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site('default', 'mysite'), {
      name: 'Mine', hosting_adapter: 'cloudflare',
    });
    await store.setDoc(paths.page('default', 'mysite', 'home'), {
      title: 'Home', slug: 'home', status: 'published',
      content_mode: 'html', body_html: '<h1>Hello</h1>',
    });
  });

  const call = async (query: string) => {
    const { GET } = await import(
      '../../pages/api/sites/[siteId]/preview/browse/[...slug]'
    );
    return GET({
      cookies: fakeCookies,
      params: { siteId: 'mysite', slug: 'home' },
      locals: {},
      request: new Request(
        `https://app.typeroll.com/api/sites/mysite/preview/browse/home${query}`,
      ),
    } as never);
  };

  it('keeps the plain preview content in an opaque child shell', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-src 'self'");
    expect(await res.text()).toContain('sandbox="allow-scripts allow-forms allow-popups"');
  });

  it("keeps the chat's draft=1 content in an opaque child shell", async () => {
    const res = await call('?draft=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-src 'self'");
    expect(await res.text()).toContain('"draft":"1"');
  });

  it('sandboxes embed=1 now that the editor uses the postMessage bridge', async () => {
    const res = await call('?embed=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(PREVIEW_SANDBOX);
  });

  it('runs only inside an opaque origin in the editor canvas', async () => {
    const res = await call('?embed=1');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBe(PREVIEW_SANDBOX);
    expect(csp).not.toContain('allow-same-origin');
  });

  it('emits no inline event handlers in the canvas, which the CSP would break', async () => {
    // script-src 'none' blocks inline handlers too, and <noscript> does NOT
    // rescue them — scripting is enabled, merely restricted. Anything the
    // shell renders that depends on an inline handler silently stops working.
    // This caught the async-CSS pattern (`onload="…this.rel='stylesheet'"`),
    // which left the canvas with no fonts at all.
    const html = await (await call('?embed=1')).text();
    const handlers = html.match(/\son[a-z]+\s*=\s*"/gi) ?? [];
    expect(handlers, `inline handlers in the editor canvas: ${handlers.join(', ')}`).toEqual([]);
  });

  it('still uses the non-blocking font pattern where scripts are allowed', async () => {
    // The plain stylesheet link is a canvas-only concession; the sandboxed
    // preview should keep the public site's async-CSS behaviour so it stays a
    // faithful preview.
    const html = await (await call(`?${PREVIEW_FRAME}`)).text();
    expect(html).toMatch(/rel="preload" as="style"/);
  });

  it('never serves a script-capable canvas on the portal origin', async () => {
    const res = await call('?embed=1');
    const html = await res.text();
    expect(html).not.toContain('window.__ran = 1');
    expect(res.headers.get('Content-Security-Policy')).toBe(PREVIEW_SANDBOX);
  });
});
