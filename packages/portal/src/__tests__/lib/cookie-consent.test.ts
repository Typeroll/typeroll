import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteSettings, SiteVersion } from '@typeroll/shared';

// Cookie-consent feature has two security-critical invariants worth pinning:
//   1. The chat AI's `update_site_settings` tool must NOT be able to write
//      cookie_consent (the scripts_optional field is a JS-injection surface,
//      same trust model as scripts_head).
//   2. The settings POST handler must accept the new fields when an admin
//      submits them, and clear them when the enabled checkbox is unchecked.

const ORG = 'default';
const SITE = 'mysite';

async function seedSite(): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), {
    name: 'My Site',
    created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main',
    kind: 'main',
    created_at: new Date().toISOString(),
    robots_blocked: false,
  } satisfies Partial<SiteVersion>);
}

describe('cookie consent — AI tool cannot write cookie_consent', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('silently drops cookie_consent from update_site_settings input', async () => {
    await seedSite();
    const { runTool } = await import('../../lib/anthropic');
    const { vstore } = await import('../../lib/version-store');

    const out = await runTool(
      'update_site_settings',
      {
        site_name: 'New Name',
        // Crafted input attempting to smuggle script through the AI tool.
        cookie_consent: {
          enabled: true,
          scripts_optional: '<script>alert("xss")</script>',
        },
      },
      {
        orgId: ORG,
        siteId: SITE,
        versionId: MAIN_VERSION_ID,
        site: { id: SITE, name: 'My Site' } as Site,
        version: null,
        portalOrigin: 'http://localhost:4321',
      },
    );

    expect((out.result as { ok: boolean }).ok).toBe(true);

    const persisted = (await vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as SiteSettings | null;
    // site_name (whitelisted) should be there:
    expect(persisted?.site_name).toBe('New Name');
    // cookie_consent must NOT have been persisted — same regression guard as
    // scripts_head, custom_css.
    expect(persisted?.cookie_consent).toBeUndefined();
  });

  it('also drops scripts_head/scripts_body_end/custom_css for parity', async () => {
    await seedSite();
    const { runTool } = await import('../../lib/anthropic');
    const { vstore } = await import('../../lib/version-store');

    await runTool(
      'update_site_settings',
      {
        scripts_head: '<script>track()</script>',
        scripts_body_end: '<script>track()</script>',
        custom_css: 'body{display:none}',
      },
      {
        orgId: ORG,
        siteId: SITE,
        versionId: MAIN_VERSION_ID,
        site: { id: SITE, name: 'My Site' } as Site,
        version: null,
        portalOrigin: 'http://localhost:4321',
      },
    );

    const persisted = (await vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as SiteSettings | null;
    expect(persisted?.scripts_head).toBeUndefined();
    expect(persisted?.scripts_body_end).toBeUndefined();
    expect(persisted?.custom_css).toBeUndefined();
  });
});

describe('cookie consent — settings POST handler', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  async function postSettings(body: FormData) {
    const { POST } = await import('../../pages/api/sites/[siteId]/settings');
    // The handler reads session/org from the cookies argument via
    // requireSiteAccess. The fixtures backend's dev-session path resolves
    // to org=default when no Firebase env is set — and the test setup
    // (vitest.setup.ts) clears FIREBASE_SERVICE_ACCOUNT. We pass a stub
    // cookies object that satisfies the AstroCookies interface enough for
    // requireSession's dev path.
    const cookies = {
      get: (_name: string) => undefined,
      set: () => {},
      delete: () => {},
      has: () => false,
    } as unknown as Parameters<typeof POST>[0]['cookies'];

    const request = new Request('http://localhost:4321/api/sites/mysite/settings', {
      method: 'POST',
      body,
    });
    const redirect = (url: string) => new Response(null, { status: 303, headers: { Location: url } });
    const params = { siteId: SITE };

    return POST({
      request,
      cookies,
      params,
      redirect,
      locals: {},
    } as unknown as Parameters<typeof POST>[0]);
  }

  it('persists cookie_consent fields when the enabled checkbox is on', async () => {
    await seedSite();
    const { vstore } = await import('../../lib/version-store');

    const form = new FormData();
    form.set('site_name', 'My Site');
    form.set('cookie_consent.enabled', 'on');
    form.set('cookie_consent.text', '<p>We use cookies.</p>');
    form.set('cookie_consent.privacy_policy_url', '/privacy');
    form.set('cookie_consent.scripts_necessary', '<script>nec()</script>');
    form.set('cookie_consent.scripts_optional', '<script>opt()</script>');
    form.set('cookie_consent.reload_after_consent', 'on');

    const res = await postSettings(form);
    expect(res.status).toBeGreaterThanOrEqual(200);

    const persisted = (await vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as SiteSettings;
    expect(persisted.cookie_consent?.enabled).toBe(true);
    expect(persisted.cookie_consent?.text).toBe('<p>We use cookies.</p>');
    expect(persisted.cookie_consent?.privacy_policy_url).toBe('/privacy');
    expect(persisted.cookie_consent?.scripts_necessary).toBe('<script>nec()</script>');
    expect(persisted.cookie_consent?.scripts_optional).toBe('<script>opt()</script>');
    expect(persisted.cookie_consent?.reload_after_consent).toBe(true);
  });

  it('clears cookie_consent when the enabled checkbox is off', async () => {
    await seedSite();
    const { vstore } = await import('../../lib/version-store');
    const { getStore } = await import('../../lib/datastore');

    // Seed an existing enabled config first.
    await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), {
      site_name: 'My Site',
      colors: { primary: '#000', secondary: '#111', accent: '#222', background: '#fff', surface: '#eee', text: '#000', text_light: '#666' },
      fonts: { heading: 'Inter', body: 'Inter', size_base: 16 },
      cookie_consent: { enabled: true, scripts_optional: '<script>alert(1)</script>' },
    } as unknown as Record<string, unknown>);

    const form = new FormData();
    form.set('site_name', 'My Site');
    // No cookie_consent.enabled field → unchecked.

    await postSettings(form);

    const persisted = (await vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as SiteSettings;
    expect(persisted.cookie_consent).toBeUndefined();
  });

  it('treats reload_after_consent absence as false (defaults to smooth swap)', async () => {
    await seedSite();
    const { vstore } = await import('../../lib/version-store');

    const form = new FormData();
    form.set('site_name', 'My Site');
    form.set('cookie_consent.enabled', 'on');
    // No reload_after_consent field — the smooth-swap default.

    await postSettings(form);

    const persisted = (await vstore.settings(ORG, SITE, MAIN_VERSION_ID)) as SiteSettings;
    expect(persisted.cookie_consent?.enabled).toBe(true);
    expect(persisted.cookie_consent?.reload_after_consent).toBe(false);
  });
});
