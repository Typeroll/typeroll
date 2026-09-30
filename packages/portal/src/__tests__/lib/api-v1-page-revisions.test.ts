// Page history over the public API: agents can list a page's saved states,
// read one, and restore it through the draft write path (save optional),
// without a portal session. Restore keeps publication state and is itself
// undoable because the commit snapshots the page it replaces.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
let token = '';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/om`, {
    title: 'Första', slug: 'om', status: 'published', content_mode: 'html', html_content: '<p>Ett</p>',
  });
  const { createApiKey } = await import('../../lib/api-keys');
  token = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' })).token;
}

async function call(modPath: string, method: 'GET' | 'POST' | 'PATCH', url: string, params: Record<string, string>, body?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ modPath)) as Partial<Record<string, APIRoute>>;
  const req = new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request: req, params: { siteId: SITE, ...params }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

const base = `/api/v1/sites/${SITE}/pages/om`;
const patchPage = (body: unknown) => call('../../pages/api/v1/sites/[siteId]/pages/[pageId]', 'PATCH', base, { pageId: 'om' }, body);
const listRevs = () => call('../../pages/api/v1/sites/[siteId]/pages/[pageId]/revisions/index', 'GET', `${base}/revisions`, { pageId: 'om' });
const readRev = (revId: string) => call('../../pages/api/v1/sites/[siteId]/pages/[pageId]/revisions/[revId]', 'GET', `${base}/revisions/${revId}`, { pageId: 'om', revId });
const restore = (revId: string, body: unknown = {}) => call('../../pages/api/v1/sites/[siteId]/pages/[pageId]/revisions/[revId]/restore', 'POST', `${base}/revisions/${revId}/restore`, { pageId: 'om', revId }, body);

async function savedPage(): Promise<Page> {
  const { getStore } = await import('../../lib/datastore');
  return (await getStore().getDoc<Page>(paths.page(ORG, SITE, 'om', MAIN_VERSION_ID)))!;
}

describe('page revisions over the v1 API', () => {
  beforeEach(async () => { await setup(); });

  it('lists, reads and restores a saved state', async () => {
    expect((await patchPage({ title: 'Andra', html_content: '<p>Två</p>', save: true })).status).toBe(200);

    const listed = await (await listRevs()).json() as { revisions: Array<{ id: string; title: string }>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.revisions[0]!.title).toBe('Första');
    const revId = listed.revisions[0]!.id;

    const one = await (await readRev(revId)).json() as { revision: { id: string; doc: Page } };
    expect(one.revision.id).toBe(revId);
    expect(one.revision.doc.html_content).toBe('<p>Ett</p>');

    // Without save the restore is a draft; the saved page is untouched.
    const staged = await (await restore(revId)).json() as { saved: boolean; has_unsaved_changes: boolean };
    expect(staged).toMatchObject({ saved: false, has_unsaved_changes: true });
    expect((await savedPage()).title).toBe('Andra');

    const saved = await (await restore(revId, { save: true })).json() as { saved: boolean; has_unsaved_changes: boolean };
    expect(saved).toMatchObject({ saved: true, has_unsaved_changes: false });
    const page = await savedPage();
    expect(page.title).toBe('Första');
    expect(page.html_content).toContain('Ett');
    expect(page.status).toBe('published');

    // The restore replaced a saved state, which is now itself restorable.
    const after = await (await listRevs()).json() as { revisions: Array<{ title: string }> };
    expect(after.revisions.map(r => r.title)).toEqual(['Andra', 'Första']);
  });

  it('refuses a revision from another content mode and unknown ids', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.revisions(ORG, SITE, 'om', MAIN_VERSION_ID)}/1-blocks`, {
      kind: 'page', created_at: new Date().toISOString(), created_by: 'x',
      doc: { title: 'Block', slug: 'om', content_mode: 'blocks', blocks: [] },
    });
    const res = await restore('1-blocks', { save: true });
    expect(res.status).toBe(409);
    expect((await savedPage()).title).toBe('Första');
    expect((await restore('missing')).status).toBe(404);
    expect((await readRev('missing')).status).toBe(404);
  });
});
