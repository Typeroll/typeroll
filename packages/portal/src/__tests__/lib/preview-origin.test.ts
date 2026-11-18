import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { previewOriginConfig, isolatedPreviewOrigin, isPreviewHost, matchesPreviewOrigin, previewHostAllows, realOriginPreviewHeaders } from '../../lib/preview-origin';
import { redirectToIsolatedPreview } from '../../lib/preview-redirect';
import { verifyPreviewToken } from '../../lib/preview-signing';
import { editorCanvasSandbox, isEditorCanvasMessage } from '../../lib/editor-canvas-frame';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

const scope = { org_id: 'default', site_id: 'mysite', version_id: 'main' };
beforeEach(() => {
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://app.example.com');
  vi.stubEnv('PREVIEW_ORIGIN_TEMPLATE', 'https://{scope}.preview-example.net');
  vi.stubEnv('PREVIEW_HMAC_SECRET', 'x'.repeat(48));
});
afterEach(() => vi.unstubAllEnvs());

describe('isolated preview boundary', () => {
  it('uses stable, distinct origins for organization, site and version', () => {
    const origin = isolatedPreviewOrigin(scope)!;
    expect(origin).toMatch(/^https:\/\/[a-f0-9]{32}\.preview-example.net$/);
    expect(isolatedPreviewOrigin({ ...scope })).toBe(origin);
    for (const field of ['org_id', 'site_id', 'version_id']) expect(isolatedPreviewOrigin({ ...scope, [field]: 'other' })).not.toBe(origin);
    expect(matchesPreviewOrigin(new Request(origin), scope)).toBe(true);
    expect(matchesPreviewOrigin(new Request('https://wrong.preview-example.net'), scope)).toBe(false);
    expect(isPreviewHost(new URL('https://nested.wrong.preview-example.net'))).toBe(true);
    expect(isPreviewHost(new URL('https://preview-example.net.attacker.test'))).toBe(false);
  });
  it.each(['https://{scope}.example.com', 'http://{scope}.other.net', 'https://a.other.net/{scope}', 'https://{scope}.other.net/path', 'https://{scope}.other.net?x=1', 'https://user:pass@{scope}.other.net'])('refuses unsafe template %s', template => {
    expect(() => previewOriginConfig({ PORTAL_PUBLIC_URL: 'https://app.example.com', PREVIEW_ORIGIN_TEMPLATE: template })).toThrow();
  });
  it.each(['/api/auth/get-session', '/api/auth/sign-in/email', '/api/v1/sites', '/app', '/api/internal-admin/sites', '/'])('never exposes portal route %s', path => {
    expect(previewHostAllows(new Request('https://a.preview-example.net' + path))).toBe(false);
  });
  it('allows only read-only preview resources', () => {
    for (const path of ['/preview/mysite/home', '/preview/mysite/media/image', '/api/preview-fonts/token/font.woff2']) {
      expect(previewHostAllows(new Request('https://a.preview-example.net' + path))).toBe(true);
      expect(previewHostAllows(new Request('https://a.preview-example.net' + path, { method: 'POST' }))).toBe(false);
    }
    expect(realOriginPreviewHeaders()['Content-Security-Policy']).toContain("frame-ancestors 'self' https://app.example.com");
    expect(realOriginPreviewHeaders()['Content-Security-Policy']).toContain("worker-src 'none'");
  });
  it('mints a scoped read capability without copying arbitrary query arguments', () => {
    const response = redirectToIsolatedPreview(new Request('https://app.example.com/api/preview?canvas=1234567890123456&interactive=1&admin=1&t=evil'), scope, { slug: 'home', workingCopy: true, canvas: true })!;
    const url = new URL(response.headers.get('Location')!);
    expect(url.origin).toBe(isolatedPreviewOrigin(scope));
    expect(url.searchParams.has('admin')).toBe(false);
    expect(verifyPreviewToken(url.searchParams.get('t'))).toMatchObject({ ...scope, wc: true, canvas: {} });
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(() => redirectToIsolatedPreview(new Request('https://app.example.com'), scope, { slug: '../../other' })).toThrow();
  });
  it('retains the opaque fallback when unconfigured', () => {
    vi.stubEnv('PREVIEW_ORIGIN_TEMPLATE', '');
    expect(isolatedPreviewOrigin(scope)).toBeNull();
    expect(redirectToIsolatedPreview(new Request('https://app.example.com'), scope, { slug: 'home' })).toBeNull();
    expect(editorCanvasSandbox()).not.toContain('allow-same-origin');
  });
  it('accepts editor messages only from the exact canvas origin and window', () => {
    const source = {};
    const frame = { contentWindow: source } as HTMLIFrameElement;
    const origin = isolatedPreviewOrigin(scope)!;
    const event = { source, origin, data: { channel: 'typeroll.editor-canvas', version: 1, canvas_id: 'canvas' } } as unknown as MessageEvent;
    expect(isEditorCanvasMessage(event, frame, 'canvas', origin)).toBe(true);
    expect(isEditorCanvasMessage({ ...event, origin: 'null' }, frame, 'canvas', origin)).toBe(false);
    expect(isEditorCanvasMessage({ ...event, source: {} } as MessageEvent, frame, 'canvas', origin)).toBe(false);
  });
});

describe('signed preview route on the isolated host', () => {
  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site('default', 'mysite'), { name: 'Mine', hosting_adapter: 'cloudflare' });
    await getStore().setDoc(paths.page('default', 'mysite', 'home'), { title: 'Home', slug: 'home', status: 'published', content_mode: 'html', html_content: '<h1>Hello</h1><iframe src="https://partner.example/form"></iframe>' });
  });
  it('redirects old links, serves a real-origin frame and refuses a different site host', async () => {
    const { signPreviewTicket } = await import('../../lib/preview-signing');
    const { GET } = await import('../../pages/preview/[siteId]/[...slug]');
    const { token } = signPreviewTicket({ orgId: 'default', siteId: 'mysite', versionId: 'main' });
    const path = `/preview/mysite/home?t=${token}&frame=1&bridge=12345678-1234-1234-1234-123456789abc`;
    const get = (origin: string) => GET({ params: { siteId: 'mysite', slug: 'home' }, request: new Request(origin + path) } as never);
    expect((await get('https://app.example.com')).status).toBe(302);
    expect((await get('https://wrong.preview-example.net')).status).toBe(403);
    const frame = await get(isolatedPreviewOrigin(scope)!);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('Content-Security-Policy')).toContain('allow-same-origin');
    expect(frame.headers.get('Set-Cookie')).toBeNull();
    expect(await frame.text()).toContain('<h1>Hello</h1>');
  });
  it('requires a signed canvas capability for editable content', async () => {
    const { signPreviewTicket } = await import('../../lib/preview-signing');
    const { GET } = await import('../../pages/preview/[siteId]/[...slug]');
    for (const canvas of [undefined, {}]) {
      const { token } = signPreviewTicket({ orgId: 'default', siteId: 'mysite', versionId: 'main', canvas });
      const response = await GET({ params: { siteId: 'mysite', slug: 'home' }, request: new Request(`${isolatedPreviewOrigin(scope)}/preview/mysite/home?t=${token}&embed=1&interactive=1&canvas=1234567890123456`) } as never);
      const html = await response.text();
      expect(html.includes('data-editor-canvas-bridge="1"')).toBe(!!canvas);
      expect(html.includes('<h1>Hello</h1>')).toBe(!!canvas);
    }
  });
});
