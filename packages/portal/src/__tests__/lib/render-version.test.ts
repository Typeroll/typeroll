// Render versions keep existing sites' output fixed until an explicit,
// previewable upgrade. Covered here: the setting over the v1 API, the
// upgrade preview signed into a preview link, and the preview renderer
// honouring the stored or requested version.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, LATEST_RENDER_VERSION, defaultSiteSettings } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion, SiteSettings } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
let token = '';

async function setup(settings: Partial<SiteSettings> = {}): Promise<void> {
  process.env.PREVIEW_HMAC_SECRET = 'a-very-long-secret-string-at-least-32-chars-x';
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), { site_name: 'S', ...settings });
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    title: 'Home', slug: 'home', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'h', type: 'core/heading', data: { text: 'Hello', level: 'h1' } }],
  });
  const { createApiKey } = await import('../../lib/api-keys');
  token = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' })).token;
}

async function call(modPath: string, method: 'GET' | 'PATCH' | 'POST', url: string, body?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ modPath)) as Partial<Record<string, APIRoute>>;
  const req = new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request: req, params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const settingsRoute = '../../pages/api/v1/sites/[siteId]/settings';

describe('render_version setting', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('new sites start at the latest version', () => {
    expect(defaultSiteSettings.render_version).toBe(LATEST_RENDER_VERSION);
  });

  it('reads a missing value as version 1 and reports the upgrade path', async () => {
    await setup();
    const body = await (await call(settingsRoute, 'GET', `/api/v1/sites/${SITE}/settings`)).json() as { render: { version: number; latest: number; upgrades: unknown[] } };
    expect(body.render.version).toBe(1);
    expect(body.render.latest).toBe(LATEST_RENDER_VERSION);
    expect(body.render.upgrades).toHaveLength(LATEST_RENDER_VERSION - 1);
  });

  it('accepts known versions and rejects anything else', async () => {
    await setup();
    for (const bad of [0, LATEST_RENDER_VERSION + 1, 1.5, '1']) {
      expect((await call(settingsRoute, 'PATCH', `/api/v1/sites/${SITE}/settings`, { render_version: bad })).status).toBe(400);
    }
    expect((await call(settingsRoute, 'PATCH', `/api/v1/sites/${SITE}/settings`, { render_version: LATEST_RENDER_VERSION })).status).toBe(200);
    const { vstore } = await import('../../lib/version-store');
    expect((await vstore.settings(ORG, SITE, MAIN_VERSION_ID))?.render_version).toBe(LATEST_RENDER_VERSION);
  });
});

describe('upgrade preview', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('renders with the stored version, or the version signed into the preview', async () => {
    await setup({ render_version: 1 });
    const { renderPreview } = await import('../../lib/render-preview');
    expect(await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID)).toContain('data-tr-render="1"');
    expect(await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, { renderVersion: LATEST_RENDER_VERSION }))
      .toContain(`data-tr-render="${LATEST_RENDER_VERSION}"`);
  });

  it('signs render_version into preview links and refuses unknown versions', async () => {
    await setup();
    const route = '../../pages/api/v1/sites/[siteId]/preview-link';
    expect((await call(route, 'POST', `/api/v1/sites/${SITE}/preview-link`, { render_version: LATEST_RENDER_VERSION + 1 })).status).toBe(400);
    const res = await call(route, 'POST', `/api/v1/sites/${SITE}/preview-link`, { render_version: LATEST_RENDER_VERSION });
    expect(res.status).toBe(200);
    const { url, render_version } = await res.json() as { url: string; render_version: number };
    expect(render_version).toBe(LATEST_RENDER_VERSION);
    const { verifyPreviewToken } = await import('../../lib/preview-signing');
    expect(verifyPreviewToken(new URL(url).searchParams.get('t'))?.rv).toBe(LATEST_RENDER_VERSION);
  });
});
