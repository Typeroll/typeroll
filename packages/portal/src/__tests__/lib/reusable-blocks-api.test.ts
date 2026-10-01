// Global blocks (referenced) and block templates (copied) over the v1 API,
// and how a referenced global block renders in the preview.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Block, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
let token = '';
const cta: Block = { id: 'cta', type: 'core/section', name: 'Book a call', data: {}, children: [{ id: 'cta-h', type: 'core/heading', data: { text: 'Book a call', level: 'h2' } }] };

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false } satisfies Partial<SiteVersion>);
  await getStore().setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), { site_name: 'S' });
  for (const id of ['home', 'about']) {
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
      title: id, slug: id, content_mode: 'blocks', status: 'published',
      blocks: [{ id: 'intro', type: 'core/prose', data: { html: '<p>Intro</p>' } }, ...(id === 'home' ? [cta] : [])],
    });
  }
  const { createApiKey } = await import('../../lib/api-keys');
  token = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' })).token;
}

async function call(route: string, method: string, params: Record<string, string>, body?: unknown): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/${route}`)) as Partial<Record<string, APIRoute>>;
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/x`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body != null ? JSON.stringify(body) : undefined,
  });
  return mod[method]!({ request: req, params: { siteId: SITE, ...params }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

async function draftBlocks(pageId: string): Promise<Block[]> {
  const { loadDraftTree } = await import('../../lib/page-draft-tree');
  return (await loadDraftTree({ orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID }, pageId))!.tree;
}

describe('reusable blocks API', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('makes a block global, references it from another page, renders it and detaches a copy', async () => {
    await setup();
    const made = await call('pages/[pageId]/blocks/make-global', 'POST', { pageId: 'home' }, { block_id: 'cta', name: 'Book a call' });
    expect(made.status).toBe(200);
    const { global_block, reference_id } = await made.json() as { global_block: { id: string }; reference_id: string };
    expect(global_block.id).toBe('book-a-call');
    const home = await draftBlocks('home');
    expect(home[1]).toMatchObject({ id: reference_id, type: 'core/global_block', data: { global_block_id: 'book-a-call' } });

    // Usage covers block references.
    const { getBlockUsage } = await import('../../lib/partials-usage');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/about`, { title: 'about', slug: 'about', content_mode: 'blocks', status: 'published', blocks: [{ id: 'r', type: 'core/global_block', data: { global_block_id: 'book-a-call' } }] });
    // The saved reference on about and the draft reference on home both count.
    expect((await getBlockUsage(ORG, SITE, MAIN_VERSION_ID, 'book-a-call')).map(page => page.page_id).sort()).toEqual(['about', 'home']);

    const { renderPreview } = await import('../../lib/render-preview');
    const html = (await renderPreview(ORG, SITE, 'about', MAIN_VERSION_ID))!;
    expect(html).toMatch(/<section[^>]*data-global-block="book-a-call"/);
    expect(html).toContain('Book a call</h2>');
    expect(html).toContain('/* core/heading */');

    const detached = await call('pages/[pageId]/blocks/detach', 'POST', { pageId: 'about' }, { block_id: 'r' });
    expect(detached.status).toBe(200);
    const about = await draftBlocks('about');
    expect(about[0].type).toBe('core/section');
    expect(about[0].id).not.toBe('cta');
    expect((await call('pages/[pageId]/blocks/detach', 'POST', { pageId: 'about' }, { block_id: about[0].id })).status).toBe(400);
  });

  it('creates global blocks with block content through the partials API', async () => {
    await setup();
    const res = await call('partials/index', 'POST', {}, { id: 'promo', name: 'Promo', blocks: [{ type: 'core/heading', data: { text: 'Promo' } }] });
    expect(res.status).toBe(201);
    const { partial } = await res.json() as { partial: { content_mode: string; blocks: Block[] } };
    expect(partial.content_mode).toBe('blocks');
    expect(partial.blocks[0].id).toMatch(/^blk_/);
    expect((await call('partials/index', 'POST', {}, { id: 'bad', blocks: [], html_content: '<p>x</p>' })).status).toBe(400);
  });

  it('saves a block template from a page and inserts independent copies', async () => {
    await setup();
    const created = await call('block-templates/index', 'POST', {}, { description: 'Call to action section', from: { page_id: 'home', block_id: 'cta' } });
    expect(created.status).toBe(201);
    const { block_template } = await created.json() as { block_template: { id: string; name: string } };
    expect(block_template).toMatchObject({ id: 'book-a-call', name: 'Book a call' });
    const list = await (await call('block-templates/index', 'GET', {})).json() as { block_templates: Array<{ id: string; block_count: number }> };
    expect(list.block_templates).toEqual([expect.objectContaining({ id: 'book-a-call', block_count: 1 })]);

    for (let i = 0; i < 2; i++) {
      expect((await call('pages/[pageId]/blocks/insert-template', 'POST', { pageId: 'about' }, { template_id: 'book-a-call', position: 0 })).status).toBe(200);
    }
    const about = await draftBlocks('about');
    expect(about.map(block => block.type)).toEqual(['core/section', 'core/section', 'core/prose']);
    expect(new Set(about.flatMap(block => [block.id, ...(block.children ?? []).map(child => child.id)])).size).toBe(5);

    expect((await call('block-templates/[templateId]', 'PATCH', { templateId: 'book-a-call' }, { name: 'CTA' })).status).toBe(200);
    expect((await call('block-templates/[templateId]', 'DELETE', { templateId: 'book-a-call' })).status).toBe(200);
    expect((await call('pages/[pageId]/blocks/insert-template', 'POST', { pageId: 'about' }, { template_id: 'book-a-call' })).status).toBe(404);
    expect((await draftBlocks('about')).length).toBe(3);
  });
});
