// commitWorkingCopy — the shared Save path (editors + agents), plus the
// v1 working-copy routes and working_copy mode on the containers blocks
// route. The invariants under test:
//   - commit runs the canonical write path: revision snapshot, SEO-safe
//     html handling, date stamps — and deletes the copy
//   - commit never changes publish status
//   - v1 agents can merge → commit → the canonical doc updates
//   - containers blocks route with working_copy leaves canonical untouched

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Partial as PartialDoc, Revision, Site, SiteVersion, WorkingCopy } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const CTX = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };

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
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

async function seedPage(id: string, over: Partial<Page> = {}): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, status: 'draft', content_mode: 'blocks',
    blocks: [], html_content: '', ...over,
  });
}

async function getPage(id: string): Promise<Page | null> {
  const { getStore } = await import('../../lib/datastore');
  return (await getStore().getDoc<Page>(paths.page(ORG, SITE, id, MAIN_VERSION_ID))) ?? null;
}

const bearer = (t: string): HeadersInit => ({ authorization: `Bearer ${t}` });

type Handlers = Partial<Record<'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH', APIRoute>>;

async function callV1Wc(
  token: string,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  target: string,
  body?: unknown,
): Promise<Response> {
  const mod = (await import('../../pages/api/v1/sites/[siteId]/working-copy/[...target]')) as Handlers;
  const handler = mod[method]!;
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/working-copy/${target}`, {
    method,
    headers: { 'content-type': 'application/json', ...bearer(token) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return handler({ request: req, params: { siteId: SITE, target }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

describe('commitWorkingCopy (lib)', () => {
  beforeEach(async () => { await setup(); });

  it('promotes fields, snapshots a revision, stamps date_updated, deletes the copy', async () => {
    await seedPage('home', { title: 'Gammal titel', status: 'published' });
    const { mergeWorkingCopy, commitWorkingCopy, readWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'home' }, { title: 'Ny titel' });

    const result = await commitWorkingCopy(CTX, { kind: 'page', id: 'home' }, 'test@example.com');
    expect(result.committed).toBe(true);

    const page = await getPage('home');
    expect(page?.title).toBe('Ny titel');
    expect(page?.status).toBe('published'); // untouched
    expect(page?.date_updated).toBeTruthy();
    expect(await readWorkingCopy(CTX, { kind: 'page', id: 'home' })).toBeNull();

    const { getStore } = await import('../../lib/datastore');
    const revs = await getStore().listDocs<Revision>(paths.revisions(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(revs.length).toBe(1);
    expect((revs[0]!.doc as unknown as Page).title).toBe('Gammal titel');
  });

  it('is a no-op when there is no working copy', async () => {
    await seedPage('home');
    const { commitWorkingCopy } = await import('../../lib/working-copy');
    const result = await commitWorkingCopy(CTX, { kind: 'page', id: 'home' }, 'x');
    expect(result.committed).toBe(false);
  });

  it('creates a partial on commit when none exists (create-on-write) and sanitizes html', async () => {
    const { mergeWorkingCopy, commitWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(CTX, { kind: 'partial', id: 'header' }, {
      html_content: '<nav>Hej</nav><script>alert(1)</script>',
    });
    const result = await commitWorkingCopy(CTX, { kind: 'partial', id: 'header' }, 'x');
    expect(result.committed).toBe(true);
    const { getStore } = await import('../../lib/datastore');
    const partial = await getStore().getDoc<PartialDoc>(paths.partial(ORG, SITE, 'header', MAIN_VERSION_ID));
    expect(partial?.kind).toBe('header');
    expect(partial?.status).toBe('draft');
    expect(partial?.html_content).toContain('Hej');
    expect(partial?.html_content).not.toContain('<script>');
  });
});

describe('v1 working-copy routes (agent surface)', () => {
  beforeEach(async () => { /* setup per test for token */ });

  it('merge → read → commit updates the canonical page; discard leaves it alone', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Sparad' });

    const put = await callV1Wc(token, 'PUT', 'page/home', {
      fields: { title: 'Agentutkast', status: 'published' },
    });
    expect(put.status).toBe(200);

    const read = await (await callV1Wc(token, 'GET', 'page/home')).json() as { working_copy: WorkingCopy };
    expect(read.working_copy.fields).toEqual({ title: 'Agentutkast' }); // status stripped
    expect((await getPage('home'))?.title).toBe('Sparad'); // canonical untouched

    const commit = await callV1Wc(token, 'POST', 'page/home');
    expect(commit.status).toBe(200);
    const commitBody = await commit.json() as { committed: boolean };
    expect(commitBody.committed).toBe(true);
    expect((await getPage('home'))?.title).toBe('Agentutkast');
    expect((await getPage('home'))?.status).toBe('draft'); // status never commits
  });

  it('discard drops the draft without touching canonical', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Sparad' });
    await callV1Wc(token, 'PUT', 'page/home', { fields: { title: 'Utkast' } });
    await callV1Wc(token, 'DELETE', 'page/home');
    const read = await (await callV1Wc(token, 'GET', 'page/home')).json() as { working_copy: WorkingCopy | null };
    expect(read.working_copy).toBeNull();
    expect((await getPage('home'))?.title).toBe('Sparad');
  });
});

describe('containers blocks route (buffer model)', () => {
  it('page mutations land in the working copy; template mutations write directly', async () => {
    const { token } = await setup();
    await seedPage('home');

    const mod = (await import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/index')) as Handlers;
    const add = await mod.POST!({
      request: new Request(`http://localhost/api/v1/sites/${SITE}/containers/page/home/blocks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer(token) },
        body: JSON.stringify({ block: { type: 'core/prose', data: { html: 'Hej' } } }),
      }),
      params: { siteId: SITE, kind: 'page', id: 'home' },
      cookies: { get: () => undefined } as any,
      locals: {} as any,
    } as any) as Response;
    expect(add.status).toBe(200);

    expect((await getPage('home'))?.blocks).toEqual([]);
    const { readWorkingCopy } = await import('../../lib/working-copy');
    const wc = await readWorkingCopy(CTX, { kind: 'page', id: 'home' });
    expect((wc?.fields.blocks as unknown[]).length).toBe(1);

    // Templates have no working copies — writes are direct (structural doc).
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.pageTemplate(ORG, SITE, 'blog', MAIN_VERSION_ID), {
      name: 'Blog', blocks: [],
    });
    const tpl = await mod.POST!({
      request: new Request(`http://localhost/api/v1/sites/${SITE}/containers/template/blog/blocks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer(token) },
        body: JSON.stringify({ block: { type: 'core/prose', data: { html: 'Tpl' } } }),
      }),
      params: { siteId: SITE, kind: 'template', id: 'blog' },
      cookies: { get: () => undefined } as any,
      locals: {} as any,
    } as any) as Response;
    expect(tpl.status).toBe(200);
    const tplDoc = await getStore().getDoc<{ blocks?: unknown[] }>(paths.pageTemplate(ORG, SITE, 'blog', MAIN_VERSION_ID));
    expect(tplDoc?.blocks).toHaveLength(1);
  });
});

describe('buffer model on v1 update_page', () => {
  async function callPage(
    token: string,
    method: 'GET' | 'PATCH',
    pageId: string,
    body?: unknown,
  ): Promise<Response> {
    const mod = (await import('../../pages/api/v1/sites/[siteId]/pages/[pageId]')) as Handlers;
    const handler = mod[method]!;
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/pages/${pageId}`, {
      method,
      headers: { 'content-type': 'application/json', ...bearer(token) },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return handler({ request: req, params: { siteId: SITE, pageId }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
  }

  it('content patches stage a draft; reads return the draft view; save:true commits', async () => {
    const { token } = await setup();
    await seedPage('home', { title: 'Sparad titel' });

    // 1. PATCH without save → draft only.
    const patch = await callPage(token, 'PATCH', 'home', { title: 'Utkasttitel' });
    expect(patch.status).toBe(200);
    const patchBody = await patch.json() as { saved: boolean; staged_fields: string[]; page: { title: string; has_unsaved_changes: boolean } };
    expect(patchBody.saved).toBe(false);
    expect(patchBody.staged_fields).toEqual(['title']);
    expect(patchBody.page.title).toBe('Utkasttitel');        // draft view
    expect(patchBody.page.has_unsaved_changes).toBe(true);
    expect((await getPage('home'))?.title).toBe('Sparad titel'); // saved doc untouched

    // 2. GET returns the draft view too.
    const got = await (await callPage(token, 'GET', 'home')).json() as { page: { title: string; has_unsaved_changes: boolean } };
    expect(got.page.title).toBe('Utkasttitel');
    expect(got.page.has_unsaved_changes).toBe(true);

    // 3. status applies immediately even while content stays drafted.
    await callPage(token, 'PATCH', 'home', { status: 'published' });
    expect((await getPage('home'))?.status).toBe('published');
    expect((await getPage('home'))?.title).toBe('Sparad titel');

    // 4. save:true commits the draft.
    const save = await callPage(token, 'PATCH', 'home', { seo_title: 'SEO', save: true });
    const saveBody = await save.json() as { saved: boolean; page: { has_unsaved_changes: boolean } };
    expect(saveBody.saved).toBe(true);
    expect(saveBody.page.has_unsaved_changes).toBe(false);
    const final = await getPage('home');
    expect(final?.title).toBe('Utkasttitel');
    expect(final?.seo_title).toBe('SEO');
  });
});

describe('owner answers across canonical API writers', () => {
  it('rejects stale drafts after an owner answer and rejects bulk replacement of No and clears', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    const { mergeWorkingCopy, commitWorkingCopy } = await import('../../lib/working-copy');
    const store = getStore();
    await store.setDoc(paths.contentType(ORG, SITE, 'profile'), { name: 'profile', fields: [
      { name: 'online', label: 'Online?', type: 'boolean', writable_by: ['portal', 'owner', 'agent', 'import'] },
    ] });
    await seedPage('stale', { content_type: 'profile', fields: { online: null } });
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'stale' }, { fields: { online: true } }, 'old-import');
    const provenance = { online: { source: 'owner' as const, actor: 'verified-synthetic-owner', updated_at: '2026-09-19T00:00:00Z' } };
    await store.updateDoc(paths.page(ORG, SITE, 'stale'), { fields: { online: false }, _provenance: provenance });
    await expect(commitWorkingCopy(CTX, { kind: 'page', id: 'stale' }, 'old-import', 'agent')).rejects.toThrow('changed after this draft');
    for (const [id, value] of [['owner-no', false], ['owner-clear', null]] as const) {
      await seedPage(id, { content_type: 'profile', fields: { online: value }, _provenance: provenance });
    }
    const { POST } = await import('../../pages/api/v1/sites/[siteId]/pages/batch-write');
    const response = await POST({ request: new Request(`http://localhost/api/v1/sites/${SITE}/pages/batch-write`, {
      method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify(['owner-no', 'owner-clear'].map(page_id => ({ page_id, save: true,
        patch: { fields: { online: true }, _provenance: {} } }))),
    }), params: { siteId: SITE } } as any);
    expect((await response.json()).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ page_id: 'owner-no', ok: false }), expect.objectContaining({ page_id: 'owner-clear', ok: false }),
    ]));
    expect((await getPage('owner-no'))?.fields?.online).toBe(false);
    expect((await getPage('owner-clear'))?.fields?.online).toBeNull();
  });
});

it('keeps keyed import evidence in batch writes and cannot replace owner answers with it', async () => {
  const { token } = await setup();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.contentType(ORG, SITE, 'profile'), { name:'profile', fields:[
    { name:'programs',type:'array',item_key:'program_id',writable_by:['portal','agent','import','owner'],fields:[
      { name:'program_id',type:'text',writable_by:['portal','agent','import'] },
      { name:'online',type:'boolean',writable_by:['portal','agent','import','owner'] },
    ] },
  ] });
  const path='programs/@stable~1a/online';
  await seedPage('source', { content_type:'profile',fields:{programs:[{program_id:'stable/a',online:null}]} });
  const { POST } = await import('../../pages/api/v1/sites/[siteId]/pages/batch-write');
  const write=async(answer_sources:unknown)=>POST({ request:new Request(`http://localhost/api/v1/sites/${SITE}/pages/batch-write`,{
    method:'POST',headers:{...bearer(token),'content-type':'application/json'},body:JSON.stringify([{page_id:'source',save:true,
      patch:{fields:{programs:[{program_id:'stable/a',online:true}]}},answer_sources}]),
  }),params:{siteId:SITE}} as any);
  expect((await (await write({[path]:{source_url:'https://example.org/program',import_run_id:'migration-2026'}})).json()).results[0].ok).toBe(true);
  const page=await getPage('source');
  expect(page?._provenance?.[path]).toMatchObject({source:'agent',source_url:'https://example.org/program',import_run_id:'migration-2026'});
  expect((await (await write({[path]:{source:'owner'}})).json()).results[0].ok).toBe(false);
  await store.updateDoc(paths.page(ORG,SITE,'source'),{fields:{programs:[{program_id:'stable/a',online:false}]},_provenance:{[path]:{source:'owner',actor:'verified-owner',updated_at:new Date().toISOString()}}});
  expect((await (await write({[path]:{source_url:'https://example.org/research'}})).json()).results[0].ok).toBe(false);
  expect((await getPage('source'))?.fields?.programs).toEqual([{program_id:'stable/a',online:false}]);
});
