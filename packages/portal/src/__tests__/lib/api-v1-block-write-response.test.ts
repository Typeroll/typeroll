// Compact answers for single-block writes.
//
// add_block, update_block and duplicate_block answered with the container's
// whole block tree, 68 kB for one add_block on an article page. With
// `response: "summary"` they answer with the changed block, where it sits and
// whether the container has unsaved changes. "tree" stays the HTTP default.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths, type Block, type Page, type Site, type SiteVersion } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const ORG = 'orgone';
const SITE = 'mysite';

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

async function setup(): Promise<string> {
  makeTmpFixtures();
  await resetDatastore();
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await s.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' })).token;
}

const heading = (id: string, text = id): Block => ({ id, type: 'core/heading', data: { text, level: 'h2' } });
const article = (): Block[] => [
  ...Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, type: 'core/prose', data: { html: `<p>${'Paragraph text. '.repeat(20)}${index}</p>` } })),
  { id: 'cols', type: 'core/columns', data: {}, slots: [[heading('left')], [heading('right-1'), heading('right-2')]] },
  { id: 'sec', type: 'core/section', data: {}, children: [heading('inner')] },
];

async function seedPage(blocks: Block[]): Promise<void> {
  await (await store()).setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
    title: 'home', slug: 'home', status: 'published', content_mode: 'blocks', blocks, html_content: '',
  } satisfies Partial<Page>);
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
async function call(route: Promise<Partial<Record<Method, APIRoute>>>, method: Method, url: string, params: Record<string, string>, token: string, body?: unknown) {
  const handler = (await route)[method]!;
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await (handler({ request, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>);
  const text = await res.text();
  return { status: res.status, size: text.length, body: JSON.parse(text) as Record<string, any> };
}

const pageRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/index');
const pageDuplicate = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/duplicate');
const pageResponsive = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]/blocks/responsive');
const containerRoute = () => import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/index');
const containerDuplicate = () => import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/duplicate');
const containerResponsive = () => import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/responsive');
const pageUrl = `http://localhost/api/v1/sites/${SITE}/pages/home/blocks`;
const pageParams = { siteId: SITE, pageId: 'home' };
const containerUrl = (kind: string, id: string, suffix = '') => `http://localhost/api/v1/sites/${SITE}/containers/${kind}/${id}/blocks${suffix}`;
const containerParams = (kind: string, id: string) => ({ siteId: SITE, kind, id });

describe('page block writes', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('add_block keeps the tree by default and answers compactly on request', async () => {
    const token = await setup();
    await seedPage(article());
    const tree = await call(pageRoute(), 'POST', pageUrl, pageParams, token, { block: heading('a') });
    expect(tree.status).toBe(200);
    expect(tree.body.blocks).toHaveLength(43);
    expect(tree.body).not.toHaveProperty('block');

    const summary = await call(pageRoute(), 'POST', pageUrl, pageParams, token, {
      block: { type: 'core/heading', data: { text: 'Right 3', level: 'h3' } }, parent_id: 'cols', slot_index: 1, position: 1, response: 'summary',
    });
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({
      added_id: expect.stringMatching(/^blk_/),
      block: { id: summary.body.added_id, type: 'core/heading', data: { text: 'Right 3', level: 'h3' } },
      parent_id: 'cols', slot_index: 1, position: 1, has_unsaved_changes: true,
    });
    expect(summary.size * 20).toBeLessThan(tree.size);
  });

  it('accepts the mode as a query parameter and rejects an unknown mode', async () => {
    const token = await setup();
    await seedPage(article());
    const viaQuery = await call(pageRoute(), 'PATCH', `${pageUrl}?response=summary`, pageParams, token, { block_id: 'inner', data: { text: 'Inner 2' } });
    expect(viaQuery.body).toEqual({
      block: { id: 'inner', type: 'core/heading', data: { text: 'Inner 2', level: 'h2' } },
      parent_id: 'sec', slot_index: null, position: 0, has_unsaved_changes: true,
    });
    // The body wins over the query.
    expect((await call(pageRoute(), 'PATCH', `${pageUrl}?response=summary`, pageParams, token, { block_id: 'inner', data: { text: 'x' }, response: 'tree' })).body.blocks).toBeDefined();
    const bad = await call(pageRoute(), 'PATCH', pageUrl, pageParams, token, { block_id: 'inner', data: { text: 'x' }, response: 'compact' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('response must be "summary" or "tree"');
  });

  it('update_block carries its warnings in the summary', async () => {
    const token = await setup();
    await seedPage(article());
    const res = await call(pageRoute(), 'PATCH', pageUrl, pageParams, token, { block_id: 'left', style_overrides: { class: 'x' }, response: 'summary' });
    expect(res.body).toMatchObject({ parent_id: 'cols', slot_index: 0, position: 0, warnings: [expect.objectContaining({ code: 'unknown_style_override' })] });
  });

  it('move_block and remove_block answer with the location', async () => {
    const token = await setup();
    await seedPage(article());
    const moved = await call(pageRoute(), 'PUT', pageUrl, pageParams, token, { block_id: 'left', target_parent_id: 'sec', target_position: 0, response: 'summary' });
    expect(moved.body).toMatchObject({ block: { id: 'left' }, parent_id: 'sec', slot_index: null, position: 0, has_unsaved_changes: true });
    const removed = await call(pageRoute(), 'DELETE', `${pageUrl}?block_id=right-2&response=summary`, pageParams, token);
    expect(removed.body).toEqual({ removed_id: 'right-2', parent_id: 'cols', slot_index: 1, position: 1, has_unsaved_changes: true });
    expect((await call(pageRoute(), 'DELETE', `${pageUrl}?block_id=p0`, pageParams, token)).body.blocks).toHaveLength(41);
  });

  it('has_unsaved_changes is false once the draft matches the saved page again', async () => {
    const token = await setup();
    await seedPage([heading('a')]);
    const added = await call(pageRoute(), 'POST', pageUrl, pageParams, token, { block: heading('b'), response: 'summary' });
    expect(added.body.has_unsaved_changes).toBe(true);
    const removed = await call(pageRoute(), 'DELETE', `${pageUrl}?block_id=b&response=summary`, pageParams, token);
    expect(removed.body).toEqual({ removed_id: 'b', parent_id: null, slot_index: null, position: 1, has_unsaved_changes: false });
  });

  it('duplicate_block and set_block_responsive answer compactly', async () => {
    const token = await setup();
    await seedPage(article());
    const copy = await call(pageDuplicate(), 'POST', `${pageUrl}/duplicate`, pageParams, token, { block_id: 'right-1', response: 'summary' });
    expect(copy.body).toMatchObject({ duplicate_id: expect.stringMatching(/^blk_/), parent_id: 'cols', slot_index: 1, position: 1, has_unsaved_changes: true });
    expect(copy.body.block).toMatchObject({ id: copy.body.duplicate_id, type: 'core/heading', data: { text: 'right-1' } });
    expect(copy.body).not.toHaveProperty('blocks');
    expect((await call(pageDuplicate(), 'POST', `${pageUrl}/duplicate`, pageParams, token, { block_id: 'p1' })).body.blocks).toHaveLength(43);

    const responsive = await call(pageResponsive(), 'POST', `${pageUrl}/responsive`, pageParams, token, { block_id: 'inner', field: 'font_size_px', value: { mobile: 20, desktop: 32 }, response: 'summary' });
    expect(responsive.body).toMatchObject({ block: { id: 'inner', data: { font_size_px: { mobile: 20, desktop: 32 } } }, parent_id: 'sec', position: 0 });
    const unknown = await call(pageResponsive(), 'POST', `${pageUrl}/responsive`, pageParams, token, { block_id: 'inner', field: 'font_sise_px', value: 20 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.unknown_fields[0].suggestions).toContain('font_size_px');
  });
});

describe('container block writes', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('a template has no working copy, so it never has unsaved changes', async () => {
    const token = await setup();
    await (await store()).setDoc(paths.pageTemplate(ORG, SITE, 'post', MAIN_VERSION_ID), { name: 'post', label: 'Post', status: 'published', created_at: '', blocks: [heading('t')] });
    const added = await call(containerRoute(), 'POST', containerUrl('template', 'post'), containerParams('template', 'post'), token, { block: heading('u'), position: 0, response: 'summary' });
    expect(added.body).toMatchObject({ added_id: 'u', parent_id: null, slot_index: null, position: 0, has_unsaved_changes: false });
    const copy = await call(containerDuplicate(), 'POST', containerUrl('template', 'post', '/duplicate'), containerParams('template', 'post'), token, { block_id: 't', response: 'summary' });
    expect(copy.body).toMatchObject({ parent_id: null, position: 2, has_unsaved_changes: false });
    const removed = await call(containerRoute(), 'DELETE', `${containerUrl('template', 'post')}?block_id=u&response=summary`, containerParams('template', 'post'), token);
    expect(removed.body).toEqual({ removed_id: 'u', parent_id: null, slot_index: null, position: 0, has_unsaved_changes: false });
  });

  it('a partial reports its working copy', async () => {
    const token = await setup();
    await (await store()).setDoc(paths.partial(ORG, SITE, 'header', MAIN_VERSION_ID), { name: 'Header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [heading('logo')] });
    const updated = await call(containerRoute(), 'PATCH', containerUrl('partial', 'header'), containerParams('partial', 'header'), token, { block_id: 'logo', data: { text: 'Logo' }, response: 'summary' });
    expect(updated.body).toEqual({ block: { id: 'logo', type: 'core/heading', data: { text: 'Logo', level: 'h2' } }, parent_id: null, slot_index: null, position: 0, has_unsaved_changes: true });
    const moved = await call(containerRoute(), 'PUT', containerUrl('partial', 'header'), containerParams('partial', 'header'), token, { block_id: 'logo', target_position: 0, response: 'summary' });
    expect(moved.body).toMatchObject({ position: 0, has_unsaved_changes: true });
    const responsive = await call(containerResponsive(), 'POST', containerUrl('partial', 'header', '/responsive'), containerParams('partial', 'header'), token, { block_id: 'logo', field: 'font_size_px', value: 24, response: 'summary' });
    expect(responsive.body).toMatchObject({ block: { id: 'logo', data: { font_size_px: 24 } }, has_unsaved_changes: true });
    // Undoing the edit brings the draft back to the saved header.
    const reverted = await call(containerRoute(), 'PATCH', containerUrl('partial', 'header'), containerParams('partial', 'header'), token, { block_id: 'logo', data: { text: 'logo', font_size_px: null }, response: 'summary' });
    expect(reverted.body.has_unsaved_changes).toBe(false);
  });
});
