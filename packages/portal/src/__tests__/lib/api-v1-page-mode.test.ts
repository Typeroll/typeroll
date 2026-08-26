// /api/v1/sites/{id}/pages/{pageId}/mode — bearer-authed mirror of the
// cookie mode route. Verifies the public surface the MCP `set_page_mode`
// tool depends on.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Revision, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' });
  return { token };
}

async function seedPage(over: Partial<Page>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const page: Page = {
    id: 'home', title: 'Home', slug: 'home',
    content_mode: 'html', status: 'published',
    html_content: '<h1>Hi</h1><p>Body</p>', ...over,
  };
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, page);
}

async function call(token: string, body: unknown, pageId: string = 'home'): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/mode');
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/pages/${pageId}/mode`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return (mod.POST as APIRoute)({
    request: req,
    params: { siteId: SITE, pageId },
    cookies: { get: () => undefined } as any,
    locals: {} as any,
  } as any) as Promise<Response>;
}

describe('POST /v1/.../pages/{id}/mode — bearer auth', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('switches HTML → blocks (no convert) and snapshots a revision', async () => {
    const { token } = await setup();
    await seedPage({});
    const res = await call(token, { to: 'blocks' });
    expect(res.status).toBe(200);
    const body = await res.json() as { content_mode: string; converted: boolean };
    expect(body.content_mode).toBe('blocks');
    expect(body.converted).toBe(false);

    const { getStore } = await import('../../lib/datastore');
    const revs = await getStore().listDocs<Revision>(paths.revisions(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(revs.length).toBe(1);
    expect(revs[0].note).toContain('html → blocks');
  });

  it('switches HTML → blocks with auto-convert', async () => {
    const { token } = await setup();
    await seedPage({});
    const res = await call(token, { to: 'blocks', convert: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { converted: boolean };
    expect(body.converted).toBe(true);

    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`);
    expect((page!.blocks ?? []).length).toBeGreaterThan(0);
    expect(page!.blocks![0].type).toBe('core/heading');
  });

  it('switches blocks → HTML (drops tree, retains in revision)', async () => {
    const { token } = await setup();
    await seedPage({
      content_mode: 'blocks',
      blocks: [{ id: 'a', type: 'core/heading', data: { text: 'Hi' } }],
      html_content: '',
    });
    const res = await call(token, { to: 'html' });
    expect(res.status).toBe(200);

    const { getStore } = await import('../../lib/datastore');
    const page = await getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`);
    expect(page!.content_mode).toBe('html');
    expect(page!.blocks).toEqual([]);
    const revs = await getStore().listDocs<Revision<Partial<Page>>>(paths.revisions(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(revs[0].doc.blocks).toHaveLength(1);
  });

  it('no-op when already in target mode', async () => {
    const { token } = await setup();
    await seedPage({});
    const res = await call(token, { to: 'html' });
    const body = await res.json() as { unchanged?: boolean };
    expect(body.unchanged).toBe(true);
  });

  it('401 without bearer token', async () => {
    await setup();
    await seedPage({});
    const mod = await import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/mode');
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/pages/home/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'blocks' }),
    });
    const res = await (mod.POST as APIRoute)({
      request: req, params: { siteId: SITE, pageId: 'home' },
      cookies: { get: () => undefined } as any, locals: {} as any,
    } as any) as Response;
    expect(res.status).toBe(401);
  });

  it('400 for invalid target mode', async () => {
    const { token } = await setup();
    await seedPage({});
    const res = await call(token, { to: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('404 for missing page', async () => {
    const { token } = await setup();
    const res = await call(token, { to: 'blocks' }, 'ghost');
    expect(res.status).toBe(404);
  });
});
