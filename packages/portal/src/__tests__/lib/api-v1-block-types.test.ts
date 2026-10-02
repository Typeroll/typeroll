// Site block types over the public API: one write path with the shared
// validator, admin-only authoring, validate/preview/starters, renames that
// move page data, data-loss refusal, usage that follows compositions, and
// lossless export/import with conflict modes.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { BLOCK_TYPE_STARTERS, MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Block, BlockType, Page, Site, SiteShare, SiteVersion } from '@typeroll/shared';

const ORG = 'ownerorg';
const PARTNER = 'partnerorg';
const SITE = 'mysite';
let adminToken = '';
let writeToken = '';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { writeShare } = await import('../../lib/shares');
  await writeShare({
    id: 'share-1', site_id: SITE, owner_org_id: ORG, shared_with_org_id: PARTNER,
    permission: 'write', created_at: Date.now(), created_by: 'owner@example.com',
  } satisfies SiteShare);
  const { createApiKey } = await import('../../lib/api-keys');
  adminToken = (await createApiKey({ orgId: ORG, siteId: SITE, name: 'admin', createdBy: 'admin' })).token;
  writeToken = (await createApiKey({ orgId: PARTNER, siteId: null, name: 'partner', createdBy: 'partner' })).token;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const ROUTES: Record<string, () => Promise<Partial<Record<Method, APIRoute>>>> = {
  index: () => import('../../pages/api/v1/sites/[siteId]/block-types/index'),
  item: () => import('../../pages/api/v1/sites/[siteId]/block-types/[typeId]'),
  usage: () => import('../../pages/api/v1/sites/[siteId]/block-types/[typeId]/usage'),
  validate: () => import('../../pages/api/v1/sites/[siteId]/block-types/validate'),
  preview: () => import('../../pages/api/v1/sites/[siteId]/block-types/preview'),
  starters: () => import('../../pages/api/v1/sites/[siteId]/block-types/starters'),
  export: () => import('../../pages/api/v1/sites/[siteId]/blocks/export'),
  import: () => import('../../pages/api/v1/sites/[siteId]/blocks/import'),
};

async function call(route: string, method: Method, opts: { typeId?: string; query?: string; body?: unknown; token?: string } = {}): Promise<Response> {
  const handler = (await ROUTES[route]!())[method];
  if (!handler) throw new Error(`No ${method} handler for ${route}`);
  const path = {
    index: 'block-types', item: `block-types/${opts.typeId}`, usage: `block-types/${opts.typeId}/usage`,
    validate: 'block-types/validate', preview: 'block-types/preview', starters: 'block-types/starters',
    export: 'blocks/export', import: 'blocks/import',
  }[route];
  const req = new Request(`http://localhost/api/v1/sites/${SITE}/${path}${opts.query ?? ''}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token ?? adminToken}` },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const params: Record<string, string> = { siteId: SITE, ...(opts.typeId ? { typeId: opts.typeId } : {}) };
  return handler({ request: req, params, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
}

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

async function seedPage(id: string, blocks: Block[], extra: Partial<Page> = {}): Promise<void> {
  await (await store()).setDoc(paths.page(ORG, SITE, id, MAIN_VERSION_ID), {
    title: id, slug: id, status: 'published', content_mode: 'blocks', blocks, ...extra,
  });
}

const iconList = BLOCK_TYPE_STARTERS.find(starter => starter.id === 'icon_list')!.definition;

const card = {
  name: 'card',
  label: 'Card',
  category: 'content',
  schema: [
    { name: 'title', type: 'text', label: 'Title' },
    { name: 'note', type: 'text', label: 'Note' },
    { name: 'points', type: 'array', label: 'Points', fields: [{ name: 'label', type: 'text', label: 'Label' }] },
  ],
  template: '<div class="card"><h3>{{title}}</h3>{{#note}}<p>{{note}}</p>{{/note}}<ul>{{#each points}}<li>{{label}}</li>{{/each}}</ul></div>',
};

describe('v1 block types: create, validate and preview', () => {
  beforeEach(async () => { await setup(); });

  it('creates a composed type and previews it with sample and given data', async () => {
    const created = await call('index', 'POST', { body: { ...iconList, styles: ':scope { gap: 2rem }' }, query: '?origin=ai' });
    expect(created.status).toBe(200);
    const body = await created.json() as { block_type: BlockType & { styles_compiled: string }; warnings: unknown[] };
    expect(body.block_type).toMatchObject({ id: 'icon_list', origin: 'ai', css_scope: 'block' });
    expect(body.block_type.composition?.length).toBeGreaterThan(0);
    expect(body.block_type.styles_compiled).toContain('[data-block="icon_list"]');

    // Preview the saved type through a patch (type_id) with given data.
    const preview = await call('preview', 'POST', { body: { type_id: 'icon_list', definition: {}, data: { items: [{ icon: 'star', title: 'Fast delivery', text: 'Same day' }] } } });
    expect(preview.status).toBe(200);
    const rendered = await preview.json() as { ok: boolean; html: string; css: string; document: string };
    expect(rendered.ok).toBe(true);
    expect(rendered.html).toContain('data-block="icon_list"');
    expect(rendered.html).toContain('Fast delivery');
    expect(rendered.css).toContain('[data-block="icon_list"]');
    expect(rendered.document).toContain('data-tr-render=');
  });

  it('previews an unsaved template type with sample data, through the sanitizer', async () => {
    const res = await call('preview', 'POST', { body: { definition: { ...card, template: `${card.template}<img src=x onerror="alert(1)">` } } });
    const body = await res.json() as { ok: boolean; html: string; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe('Title');
    expect(body.html).toContain('<h3>Title</h3>');
    expect(body.html).toContain('<li>Label 1</li>');
    expect(body.html).not.toContain('onerror');
    expect(await (await store()).getDoc(paths.blockType(ORG, SITE, 'card', MAIN_VERSION_ID))).toBeNull();
  });

  it('does not render a definition with errors', async () => {
    const body = await (await call('preview', 'POST', { body: { definition: { ...card, template: '{{#each points}}' } } })).json() as { ok: boolean; html: string; problems: Array<{ path: string }> };
    expect(body.ok).toBe(false);
    expect(body.html).toBe('');
    expect(body.problems[0]!.path).toBe('/template');
  });

  it('validates without saving and reports problems with paths and lines', async () => {
    const res = await call('validate', 'POST', { body: { ...card, schema: [...card.schema, { name: 'x_svg', type: 'text', label: 'X' }], template: 'line one\n<p>{{titel}}</p>' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; problems: Array<{ severity: string; path: string; line?: number; message: string }>; merged: BlockType };
    expect(body.ok).toBe(false);
    expect(body.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: '/schema/3/name' }),
      expect.objectContaining({ severity: 'error', path: '/template', line: 2 }),
    ]));
    expect(body.merged.name).toBe('card');
  });

  it('refuses invalid writes with 400 and every problem, and a taken name with 409', async () => {
    const bad = await call('index', 'POST', { body: { ...card, label: '', unknown_prop: 1 } });
    expect(bad.status).toBe(400);
    const body = await bad.json() as { error: string; problems: Array<{ path: string }> };
    expect(body.problems.map(p => p.path)).toEqual(expect.arrayContaining(['/label', '/unknown_prop']));
    expect((await call('index', 'POST', { body: card })).status).toBe(200);
    expect((await call('index', 'POST', { body: card })).status).toBe(409);
    // Names the API uses beside /block-types/{id} are reserved.
    expect((await call('index', 'POST', { body: { ...card, name: 'preview' } })).status).toBe(400);
  });

  it('lists the starters', async () => {
    const body = await (await call('starters', 'GET')).json() as { starters: Array<{ id: string; definition: BlockType }> };
    expect(body.starters.map(s => s.id)).toContain('icon_list');
  });

  it('needs admin to create, change, delete and import; a write share may validate and preview', async () => {
    expect((await call('index', 'POST', { body: card })).status).toBe(200);
    const asEditor = { token: writeToken };
    const refused = await call('index', 'POST', { ...asEditor, body: { ...card, name: 'other' } });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: string }).error).toMatch(/admin/);
    expect((await call('item', 'PATCH', { ...asEditor, typeId: 'card', body: { label: 'x' } })).status).toBe(403);
    expect((await call('item', 'DELETE', { ...asEditor, typeId: 'card' })).status).toBe(403);
    expect((await call('import', 'POST', { ...asEditor, body: { zip_base64: 'x' } })).status).toBe(403);
    expect((await call('validate', 'POST', { ...asEditor, body: card })).status).toBe(200);
    expect((await call('preview', 'POST', { ...asEditor, body: { definition: card } })).status).toBe(200);
    expect((await call('item', 'GET', { ...asEditor, typeId: 'card' })).status).toBe(200);
  });
});

describe('v1 block types: changing a type in use', () => {
  beforeEach(async () => { await setup(); });

  async function seedUses(): Promise<void> {
    expect((await call('index', 'POST', { body: card })).status).toBe(200);
    const instance = (id: string, data: Record<string, unknown>): Block => ({ id, type: 'card', data });
    await seedPage('home', [{ id: 'sec', type: 'core/section', data: {}, children: [instance('c1', { title: 'Home card', points: [{ label: 'One' }] })] }]);
    // A draft of the same page and a header that use the type.
    await (await store()).setDoc(paths.workingCopy(ORG, SITE, 'page--home', MAIN_VERSION_ID), {
      kind: 'page', target_id: 'home', updated_at: '', fields: { blocks: [instance('c1', { title: 'Draft card' })] },
    });
    await (await store()).setDoc(paths.partial(ORG, SITE, 'header', MAIN_VERSION_ID), {
      name: 'Header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [instance('h1', { title: 'Header card' })],
    });
    // A page template, a block template, a repeater with the type as item and a composed type.
    await (await store()).setDoc(paths.pageTemplate(ORG, SITE, 'article', MAIN_VERSION_ID), {
      name: 'article', label: 'Article', status: 'published', created_at: '', blocks: [instance('t1', { title: 'Template card' })],
    });
    await (await store()).setDoc(paths.blockTemplate(ORG, SITE, 'promo'), {
      name: 'Promo', created_at: '', updated_at: '', blocks: [instance('b1', { title: 'Block template card' })],
    });
    await seedPage('list', [{ id: 'r', type: 'core/repeater', data: { source_type: 'static', item_block: 'card', items: [{ title: 'Item card' }] } }]);
    expect((await call('index', 'POST', { body: {
      name: 'card_pair', label: 'Card pair', schema: [{ name: 'first', type: 'text', label: 'First' }],
      composition: [{ id: 'a', type: 'card', data: { title: '{{props.first}}' } }],
    } })).status).toBe(200);
  }

  const renamedSchema = [
    { name: 'heading', type: 'text', label: 'Heading' },
    { name: 'note', type: 'text', label: 'Note' },
    { name: 'points', type: 'array', label: 'Points', fields: [{ name: 'text', type: 'text', label: 'Text' }] },
  ];
  const renamedTemplate = '<div class="card"><h3>{{heading}}</h3><ul>{{#each points}}<li>{{text}}</li>{{/each}}</ul></div>';

  it('renames move data in every use and snapshot a revision of changed pages', async () => {
    await seedUses();
    const res = await call('item', 'PATCH', { typeId: 'card', body: {
      schema: renamedSchema, template: renamedTemplate, renames: { title: 'heading', 'points.label': 'text' },
    } });
    expect(res.status).toBe(200);
    const body = await res.json() as { block_type: BlockType; impact: { usages: Array<{ kind: string; id: string; instances: number }>; renamed: unknown[] } };
    expect(body.block_type.schema.map(f => f.name)).toEqual(['heading', 'note', 'points']);
    expect(body.impact.renamed).toEqual([{ from: 'title', to: 'heading' }, { from: 'points.label', to: 'points.text' }]);
    expect(body.impact.usages.map(u => `${u.kind}:${u.id}`).sort()).toEqual([
      'block_template:promo', 'block_type:card_pair', 'page:home', 'page:list', 'page_draft:home', 'page_template:article', 'partial:header',
    ]);

    const s = await store();
    const home = await s.getDoc<Page>(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(home!.blocks![0]!.children![0]!.data).toEqual({ heading: 'Home card', points: [{ text: 'One' }] });
    const draft = await s.getDoc<{ fields: { blocks: Block[] } }>(paths.workingCopy(ORG, SITE, 'page--home', MAIN_VERSION_ID));
    expect(draft!.fields.blocks[0]!.data).toEqual({ heading: 'Draft card' });
    expect((await s.getDoc<{ blocks: Block[] }>(paths.partial(ORG, SITE, 'header', MAIN_VERSION_ID)))!.blocks[0]!.data).toEqual({ heading: 'Header card' });
    expect((await s.getDoc<{ blocks: Block[] }>(paths.pageTemplate(ORG, SITE, 'article', MAIN_VERSION_ID)))!.blocks[0]!.data).toEqual({ heading: 'Template card' });
    expect((await s.getDoc<{ blocks: Block[] }>(paths.blockTemplate(ORG, SITE, 'promo')))!.blocks[0]!.data).toEqual({ heading: 'Block template card' });
    expect((await s.getDoc<Page>(paths.page(ORG, SITE, 'list', MAIN_VERSION_ID)))!.blocks![0]!.data.items).toEqual([{ heading: 'Item card' }]);
    expect((await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'card_pair', MAIN_VERSION_ID)))!.composition![0]!.data).toEqual({ heading: '{{props.first}}' });

    // The pre-change page is kept as a revision.
    const revisions = await s.listDocs<{ doc: Page; note?: string }>(paths.revisions(ORG, SITE, 'home', MAIN_VERSION_ID));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.doc.blocks![0]!.children![0]!.data).toMatchObject({ title: 'Home card' });
    expect(revisions[0]!.note).toContain('card');
  });

  it('refuses to drop data unconfirmed, listing where; confirm_data_loss drops it', async () => {
    await seedUses();
    const s = await store();
    await seedPage('notes', [{ id: 'n', type: 'card', data: { title: 'T', note: 'Keep me?' } }]);
    const withoutNote = { schema: card.schema.filter(f => f.name !== 'note'), template: '<div><h3>{{title}}</h3></div>' };
    const refused = await call('item', 'PATCH', { typeId: 'card', body: withoutNote });
    expect(refused.status).toBe(409);
    const body = await refused.json() as { error: string; impact: { removed: string[]; usages: Array<{ id: string; data_loss: string[] }> } };
    expect(body.impact.removed).toEqual(['note']);
    expect(body.impact.usages).toEqual([expect.objectContaining({ id: 'notes', data_loss: ['note'] })]);
    // Nothing changed.
    expect((await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'card', MAIN_VERSION_ID)))!.schema).toHaveLength(3);

    const confirmed = await call('item', 'PATCH', { typeId: 'card', body: { ...withoutNote, confirm_data_loss: true } });
    expect(confirmed.status).toBe(200);
    expect((await s.getDoc<Page>(paths.page(ORG, SITE, 'notes', MAIN_VERSION_ID)))!.blocks![0]!.data).toEqual({ title: 'T' });
  });

  it('a change that removes a field nobody filled in needs no confirmation', async () => {
    await seedUses();
    const res = await call('item', 'PATCH', { typeId: 'card', body: { schema: card.schema.filter(f => f.name !== 'note'), template: '<div><h3>{{title}}</h3></div>' } });
    expect(res.status).toBe(200);
  });

  it('rejects renames that name no field', async () => {
    await seedUses();
    const res = await call('item', 'PATCH', { typeId: 'card', body: { schema: renamedSchema, template: renamedTemplate, renames: { titel: 'heading' } } });
    expect(res.status).toBe(400);
    const body = await res.json() as { problems: Array<{ path: string }> };
    expect(body.problems.map(p => p.path)).toContain('/renames/titel');
  });

  it('renaming a composed type\'s prop rewrites its own bindings', async () => {
    expect((await call('index', 'POST', { body: iconList })).status).toBe(200);
    await seedPage('home', [{ id: 'i', type: 'icon_list', data: { items: [{ icon: 'star', title: 'Fast' }] } }]);
    const schema = JSON.parse(JSON.stringify(iconList.schema)) as BlockType['schema'];
    schema[0]!.fields!.find(f => f.name === 'title')!.name = 'heading';
    schema[0]!.item_label = 'heading';
    const res = await call('item', 'PATCH', { typeId: 'icon_list', body: { schema, renames: { 'items.title': 'heading' } } });
    expect(res.status).toBe(200);
    const body = await res.json() as { block_type: BlockType };
    expect(JSON.stringify(body.block_type.composition)).toContain('{{item.heading}}');
    expect(JSON.stringify(body.block_type.composition)).not.toContain('{{item.title}}');
    expect((await (await store()).getDoc<Page>(paths.page(ORG, SITE, 'home', MAIN_VERSION_ID)))!.blocks![0]!.data.items).toEqual([{ icon: 'star', heading: 'Fast' }]);
  });
});

describe('v1 block types: usage and delete', () => {
  beforeEach(async () => { await setup(); });

  it('usage follows compositions, repeaters and drafts; delete refuses while used', async () => {
    expect((await call('index', 'POST', { body: card })).status).toBe(200);
    expect((await call('index', 'POST', { body: {
      name: 'card_pair', label: 'Card pair', schema: [{ name: 'first', type: 'text', label: 'First' }],
      composition: [{ id: 'a', type: 'card', data: { title: '{{props.first}}' } }],
    } })).status).toBe(200);
    // The composed type is placed on a page; the card itself only in a draft and as a repeater item.
    await seedPage('home', [{ id: 'p', type: 'card_pair', data: { first: 'x' } }]);
    await seedPage('about', [], {});
    await (await store()).setDoc(paths.workingCopy(ORG, SITE, 'page--about', MAIN_VERSION_ID), {
      kind: 'page', target_id: 'about', updated_at: '', fields: { blocks: [{ id: 'r', type: 'core/repeater', data: { item_block: 'card', items: [] } }] },
    });

    const usage = await (await call('usage', 'GET', { typeId: 'card' })).json() as {
      total: number;
      pages: Array<{ page_id: string; sources: string[]; via?: string[] }>;
      block_types: Array<{ type_id: string; via: string[] }>;
    };
    expect(usage.block_types).toEqual([expect.objectContaining({ type_id: 'card_pair', via: ['composition'] })]);
    expect(usage.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ page_id: 'home', sources: ['saved'], via: ['card_pair'] }),
      expect.objectContaining({ page_id: 'about', sources: ['draft'] }),
    ]));
    expect(usage.total).toBe(3);

    const del = await call('item', 'DELETE', { typeId: 'card' });
    expect(del.status).toBe(409);
    expect((await del.json() as { error: string }).error).toMatch(/other block type/);
  });
});

describe('v1 block types: export and import', () => {
  beforeEach(async () => { await setup(); });

  async function exportAll(): Promise<string> {
    const res = await call('export', 'GET', { query: '?name=pkg&version=1' });
    const body = await res.json() as { zip_base64: string; block_count: number };
    expect(body.block_count).toBeGreaterThan(0);
    return body.zip_base64;
  }
  const importZip = async (zip: string, onConflict?: string) => (await call('import', 'POST', {
    body: { zip_base64: zip, ...(onConflict ? { on_conflict: onConflict } : {}) },
  })).json() as Promise<{ created: number; updated: number; renamed: number; skipped: number; failed: number; results: Array<{ name: string; action: string; id?: string; problems?: unknown[] }> }>;

  it('round-trips composed and agent-made types without losing properties', async () => {
    const composed = { ...iconList, description: 'Benefits', styles: ':scope { gap: 1rem }' };
    expect((await call('index', 'POST', { body: composed, query: '?origin=ai' })).status).toBe(200);
    expect((await call('index', 'POST', { body: { ...card, item_compatible: true, schema: [{ ...card.schema[0], help: 'Shown big' }, ...card.schema.slice(1)] } })).status).toBe(200);
    const zip = await exportAll();
    const s = await store();
    const before = await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'icon_list', MAIN_VERSION_ID));
    for (const id of ['icon_list', 'card']) await s.deleteDoc(paths.blockType(ORG, SITE, id, MAIN_VERSION_ID));

    const result = await importZip(zip);
    expect(result).toMatchObject({ created: 2, failed: 0 });
    const after = await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'icon_list', MAIN_VERSION_ID));
    expect(after).toMatchObject({ origin: 'third_party', css_scope: 'block', description: 'Benefits', styles: composed.styles });
    expect(after!.composition).toEqual(before!.composition);
    expect(after!.schema).toEqual(before!.schema);
    const cardAfter = await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'card', MAIN_VERSION_ID));
    expect(cardAfter).toMatchObject({ item_compatible: true });
    expect(cardAfter!.schema[0]!.help).toBe('Shown big');
  });

  it('skips, renames or replaces on a name conflict and reports each type', async () => {
    expect((await call('index', 'POST', { body: card })).status).toBe(200);
    expect((await call('index', 'POST', { body: {
      name: 'card_pair', label: 'Card pair', schema: [{ name: 'first', type: 'text', label: 'First' }],
      composition: [{ id: 'a', type: 'card', data: { title: '{{props.first}}' } }],
    } })).status).toBe(200);
    const zip = await exportAll();
    const s = await store();
    await s.setDoc(paths.blockType(ORG, SITE, 'card', MAIN_VERSION_ID), { ...card, id: 'card', label: 'Changed here', container: false, origin: 'user', created_at: '' });

    const skipped = await importZip(zip);
    expect(skipped).toMatchObject({ skipped: 2, created: 0 });
    expect((await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'card', MAIN_VERSION_ID)))!.label).toBe('Changed here');

    const renamed = await importZip(zip, 'rename');
    expect(renamed.renamed).toBe(2);
    expect(renamed.results.map(r => r.id).sort()).toEqual(['card_2', 'card_pair_2']);
    // References inside the package follow the rename.
    expect((await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'card_pair_2', MAIN_VERSION_ID)))!.composition![0]!.type).toBe('card_2');

    const replaced = await importZip(zip, 'replace');
    expect(replaced.updated).toBe(2);
    expect((await s.getDoc<BlockType>(paths.blockType(ORG, SITE, 'card', MAIN_VERSION_ID)))!.label).toBe('Card');

    expect((await call('import', 'POST', { body: { zip_base64: zip, on_conflict: 'merge' } })).status).toBe(400);
  });

  it('validates each imported definition and reports failures without writing them', async () => {
    const { packBlockTypes } = await import('../../lib/block-packages');
    const zip = (await packBlockTypes({ manifest: { name: 'bad', version: '1' }, block_types: [
      { id: 'broken', name: 'broken', label: 'Broken', category: 'content', container: false, schema: [], template: '<p>{{missing}}</p>', created_at: '' },
      { id: 'fine', name: 'fine', label: 'Fine', category: 'content', container: 'repeater', schema: [], created_at: '' },
    ] })).toString('base64');
    const result = await importZip(zip);
    expect(result).toMatchObject({ created: 1, failed: 1 });
    expect(result.results.find(r => r.name === 'broken')).toMatchObject({ action: 'failed', problems: [expect.objectContaining({ path: '/template' })] });
    expect(await (await store()).getDoc(paths.blockType(ORG, SITE, 'broken', MAIN_VERSION_ID))).toBeNull();
  });
});
