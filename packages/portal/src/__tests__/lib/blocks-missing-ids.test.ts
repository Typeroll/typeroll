// Regression: hand-authored Block[] trees without per-block ids.
//
// Agents that call create_page/PATCH with a whole block tree routinely omit
// ids (run 2 of the Gruppsupporter eval did — every preview of the page
// returned HTTP 500 from `sanitizeCssId(undefined)`). Two guarantees:
//
//  1. The renderer never crashes on an id-less block (defensive).
//  2. Write paths normalise: blocks persisted via the v1 API always carry
//     ids afterwards (ensureBlockIds at create/patch/writeContainer).

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Block, Page, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

// A miniature of run 2's hand-authored tree: nested children, a slots
// container, zero ids anywhere.
const ID_LESS_TREE = [
  { type: 'core/section', data: { background: 'surface' }, children: [
    { type: 'core/heading', data: { text: 'Rubrik', level: 'h1' } },
    { type: 'core/prose', data: { html: '<p>Hej</p>' } },
  ] },
  { type: 'core/columns', data: {}, slots: [
    [{ type: 'core/prose', data: { html: '<p>vänster</p>' } }],
    [{ type: 'core/prose', data: { html: '<p>höger</p>' } }],
  ] },
] as unknown as Block[];

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

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  params: Record<string, string>,
  init?: { headers?: HeadersInit; body?: unknown },
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.body != null ? JSON.stringify(init.body) : undefined,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
const bearer = (t: string): HeadersInit => ({ authorization: `Bearer ${t}` });

function collectIds(blocks: Block[]): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      out.push(b.id);
      if (b.children) walk(b.children);
      for (const slot of b.slots ?? []) walk(slot);
    }
  };
  walk(blocks);
  return out;
}

describe('id-less block trees', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('renderer does not crash on a block without id', async () => {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/no-ids`, {
      title: 'No ids', slug: 'no-ids', status: 'draft',
      content_mode: 'blocks', blocks: structuredClone(ID_LESS_TREE),
    });
    const { renderPreviewBySlug } = await import('../../lib/render-preview');
    const res = await renderPreviewBySlug(ORG, SITE, ['no-ids'], MAIN_VERSION_ID, {});
    expect(res).toBeTypeOf('string');
    const html = res as string;
    expect(html).toContain('Rubrik');
  });

  it('create_page (v1 POST) assigns ids to every block in the tree', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/pages`,
      { siteId: SITE },
      { headers: bearer(token), body: { title: 'Blocks', slug: 'blocks', content_mode: 'blocks', blocks: structuredClone(ID_LESS_TREE) } },
    );
    expect(res.status).toBe(201);
    const { getStore } = await import('../../lib/datastore');
    const stored = await getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/blocks`);
    const ids = collectIds(stored?.blocks ?? []);
    expect(ids).toHaveLength(6);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(6);
  });

  it('PATCH page blocks assigns ids too', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/p1`, {
      title: 'P1', slug: 'p1', status: 'draft', content_mode: 'blocks', blocks: [],
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/p1`,
      { siteId: SITE, pageId: 'p1' },
      { headers: bearer(token), body: { blocks: structuredClone(ID_LESS_TREE) } },
    );
    expect(res.status).toBe(200);
    const stored = await getStore().getDoc<Page>(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/p1`);
    expect(collectIds(stored?.blocks ?? []).every((id) => typeof id === 'string' && id!.length > 0)).toBe(true);
  });
});

describe('preview href rewriting — anchors', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('rewrites root+anchor hrefs into the preview surface with fragment after the token', async () => {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/links`, {
      title: 'Links', slug: 'links', status: 'draft', content_mode: 'html',
      html_content: '<a href="/#ansokan">CTA</a><a href="/om#avsnitt">Om</a><a href="#lokal">Lokal</a><a href="/om">Om2</a><a href="//cdn.example.com/x">Ext</a><a href="/om2?x=1#f">Q</a>',
    });
    const { renderPreviewBySlug } = await import('../../lib/render-preview');
    const res = await renderPreviewBySlug(ORG, SITE, ['links'], MAIN_VERSION_ID, {
      browseRoot: '/preview/mysite', embedSuffix: '?t=TOKEN',
    });
    expect(res).toBeTypeOf('string');
    const html = res as string;
    // Root + anchor: token first, fragment after — stays inside the preview.
    expect(html).toContain('href="/preview/mysite/?t=TOKEN#ansokan"');
    // Path + anchor.
    expect(html).toContain('href="/preview/mysite/om?t=TOKEN#avsnitt"');
    // Pure anchor untouched (same-page scroll).
    expect(html).toContain('href="#lokal"');
    // Plain path rewritten as before.
    expect(html).toContain('href="/preview/mysite/om?t=TOKEN"');
    // Protocol-relative untouched.
    expect(html).toContain('href="//cdn.example.com/x"');
    // Href with existing query string: token joined with &, not a second ?.
    expect(html).toContain('href="/preview/mysite/om2?x=1&t=TOKEN#f"');
  });
});

describe('blocks-mode shell', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('blocks pages get the unconstrained page-content--blocks shell', async () => {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/b`, {
      title: 'B', slug: 'b', status: 'draft', content_mode: 'blocks',
      blocks: [{ id: 'blk_1', type: 'core/section', data: {}, children: [
        { id: 'blk_2', type: 'core/prose', data: { html: '<p>x</p>' } },
      ] }],
    });
    const { renderPreviewBySlug } = await import('../../lib/render-preview');
    const res = await renderPreviewBySlug(ORG, SITE, ['b'], MAIN_VERSION_ID, {});
    expect(res).toContain('class="page-content page-content--blocks"');
    expect(res).toContain('.page-content--blocks{max-width:none;padding:0}');
  });

  it('html pages keep the classic padded shell', async () => {
    await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/h`, {
      title: 'H', slug: 'h', status: 'draft', content_mode: 'html', html_content: '<p>x</p>',
    });
    const { renderPreviewBySlug } = await import('../../lib/render-preview');
    const res = await renderPreviewBySlug(ORG, SITE, ['h'], MAIN_VERSION_ID, {});
    expect(res).toContain('class="page-content"');
    expect(res).not.toContain('page-content--blocks"');
  });
});
