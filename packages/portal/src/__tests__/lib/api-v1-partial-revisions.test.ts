// Partial history over the public API: list a partial's saved states, read
// one, and restore it through the draft write path (save optional), the same
// history the portal's partial editor restores from.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Partial as PartialDoc, Site, SiteVersion } from '@typeroll/shared';

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
  await getStore().setDoc(paths.partial(ORG, SITE, 'footer', MAIN_VERSION_ID), {
    name: 'Footer', kind: 'footer', status: 'published', content_mode: 'html', html_content: '<p>Första</p>',
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

const base = `/api/v1/sites/${SITE}/partials/footer`;
const patchPartial = (body: unknown) => call('../../pages/api/v1/sites/[siteId]/partials/[partialId]', 'PATCH', base, { partialId: 'footer' }, body);
const listRevs = (partialId = 'footer') => call('../../pages/api/v1/sites/[siteId]/partials/[partialId]/revisions/index', 'GET', `/api/v1/sites/${SITE}/partials/${partialId}/revisions`, { partialId });
const readRev = (revId: string) => call('../../pages/api/v1/sites/[siteId]/partials/[partialId]/revisions/[revId]', 'GET', `${base}/revisions/${revId}`, { partialId: 'footer', revId });
const restore = (revId: string, body: unknown = {}) => call('../../pages/api/v1/sites/[siteId]/partials/[partialId]/revisions/[revId]/restore', 'POST', `${base}/revisions/${revId}/restore`, { partialId: 'footer', revId }, body);

async function savedPartial(): Promise<PartialDoc> {
  const { getStore } = await import('../../lib/datastore');
  return (await getStore().getDoc<PartialDoc>(paths.partial(ORG, SITE, 'footer', MAIN_VERSION_ID)))!;
}

describe('partial revisions over the v1 API', () => {
  beforeEach(async () => { await setup(); });

  it('lists, reads and restores a saved state', async () => {
    expect((await patchPartial({ html_content: '<p>Andra</p>', save: true })).status).toBe(200);

    const listed = await (await listRevs()).json() as { revisions: Array<{ id: string; name: string; content_mode: string }>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.revisions[0]).toMatchObject({ name: 'Footer', content_mode: 'html' });
    const revId = listed.revisions[0]!.id;

    const one = await (await readRev(revId)).json() as { revision: { id: string; doc: PartialDoc } };
    expect(one.revision.id).toBe(revId);
    expect(one.revision.doc.html_content).toBe('<p>Första</p>');

    // Without save the restore is a draft; the saved partial is untouched.
    const staged = await (await restore(revId)).json() as { saved: boolean; has_unsaved_changes: boolean };
    expect(staged).toMatchObject({ saved: false, has_unsaved_changes: true });
    expect((await savedPartial()).html_content).toContain('Andra');

    const saved = await (await restore(revId, { save: true })).json() as { saved: boolean; has_unsaved_changes: boolean };
    expect(saved).toMatchObject({ saved: true, has_unsaved_changes: false });
    const partial = await savedPartial();
    expect(partial.html_content).toContain('Första');
    expect(partial.status).toBe('published');
    expect(partial.kind).toBe('footer');

    // The restore replaced a saved state, which is now itself restorable.
    const after = await (await listRevs()).json() as { total: number };
    expect(after.total).toBe(2);
  });

  it('refuses a revision from another content mode and unknown ids', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.partialRevisions(ORG, SITE, 'footer', MAIN_VERSION_ID)}/1-blocks`, {
      kind: 'partial', created_at: new Date().toISOString(), created_by: 'x',
      doc: { name: 'Footer', kind: 'footer', content_mode: 'blocks', blocks: [] },
    });
    expect((await restore('1-blocks', { save: true })).status).toBe(409);
    expect((await savedPartial()).html_content).toContain('Första');
    expect((await restore('missing')).status).toBe(404);
    expect((await readRev('missing')).status).toBe(404);
    expect((await listRevs('nope')).status).toBe(404);
  });
});
