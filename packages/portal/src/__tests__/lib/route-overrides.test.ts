// Block.route_overrides through the write API and the preview: a shared header
// banner that is primary on the home page and secondary elsewhere, with no
// site CSS and one block.

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

const banner = (over: Partial<Block> = {}): Block => ({
  id: 'banner', type: 'core/section', data: { background: 'secondary' },
  style_overrides: { custom_class: 'service-banner-header-surface' },
  children: [{ id: 'banner-text', type: 'core/prose', data: { html: '<p>Flyttstädning med garanti</p>' } }],
  ...over,
});
const HOME_PRIMARY = { home: { data_overrides: { background: 'primary' } } };

async function seedHeader(blocks: Block[]): Promise<void> {
  await (await store()).setDoc(paths.partial(ORG, SITE, 'header', MAIN_VERSION_ID), { name: 'Header', kind: 'header', status: 'published', content_mode: 'blocks', blocks });
}

async function seedPage(id: string, slug: string): Promise<void> {
  await (await store()).setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug, status: 'published', content_mode: 'blocks', html_content: '',
    blocks: [{ id: `${id}-h`, type: 'core/heading', data: { text: id, level: 'h1' } }],
  } satisfies Partial<Page>);
}

type Method = 'POST' | 'PATCH';
async function call(method: Method, body: unknown, token: string) {
  const handler = (await import('../../pages/api/v1/sites/[siteId]/containers/[kind]/[id]/blocks/index'))[method]! as APIRoute;
  const request = new Request(`http://localhost/api/v1/sites/${SITE}/containers/partial/header/blocks`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const res = await (handler({ request, params: { siteId: SITE, kind: 'partial', id: 'header' }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>);
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, any> };
}

describe('route_overrides writes', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('update_block sets, replaces and clears a block\'s route overrides', async () => {
    const token = await setup();
    await seedHeader([banner()]);
    const set = await call('PATCH', { block_id: 'banner', route_overrides: HOME_PRIMARY, response: 'summary' }, token);
    expect(set.status).toBe(200);
    expect(set.body.block.route_overrides).toEqual(HOME_PRIMARY);
    expect(set.body.block.data).toEqual({ background: 'secondary' });
    const cleared = await call('PATCH', { block_id: 'banner', route_overrides: null, response: 'summary' }, token);
    expect(cleared.status).toBe(200);
    expect(cleared.body.block).not.toHaveProperty('route_overrides');
  });

  it('refuses a route that is not a route kind, and override data the block type does not declare', async () => {
    const token = await setup();
    await seedHeader([banner()]);
    const route = await call('PATCH', { block_id: 'banner', route_overrides: { homepage: { data_overrides: { background: 'primary' } } } }, token);
    expect(route.status).toBe(400);
    expect(route.body.error).toMatch(/route_overrides\.homepage is not a route kind/);
    const key = await call('PATCH', { block_id: 'banner', route_overrides: { home: { data_overrides: { backgroud: 'primary' } } } }, token);
    expect(key.status).toBe(400);
    expect(key.body.code).toBe('unknown_field');
    expect(key.body.unknown_fields[0]).toMatchObject({ path: 'route_overrides.home.data_overrides.backgroud', suggestions: expect.arrayContaining(['background']) });
  });

  it('add_block stores route overrides and refuses malformed ones with a 400', async () => {
    const token = await setup();
    await seedHeader([]);
    const added = await call('POST', { block: banner({ route_overrides: HOME_PRIMARY }), response: 'summary' }, token);
    expect(added.status).toBe(200);
    expect(added.body.block.route_overrides).toEqual(HOME_PRIMARY);
    const bad = await call('POST', { block: banner({ id: 'b2', route_overrides: { home: { background: 'primary' } } as never }) }, token);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/block\[0\]\.route_overrides\.home\.background is not supported/);
  });
});

describe('route_overrides in the preview', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('renders the header banner primary on the home page and secondary elsewhere, on the route <body> names', async () => {
    await setup();
    await seedHeader([banner({ route_overrides: HOME_PRIMARY })]);
    await seedPage('home', 'home');
    await seedPage('about', 'om-oss');
    const { renderPreview } = await import('../../lib/render-preview');
    const home = (await renderPreview(ORG, SITE, 'home', MAIN_VERSION_ID, {}))!;
    const about = (await renderPreview(ORG, SITE, 'about', MAIN_VERSION_ID, {}))!;
    expect(home).toMatch(/<body[^>]* data-route="home"/);
    expect(about).toMatch(/<body[^>]* data-route="page"/);
    const section = (html: string) => html.match(/<section data-block="section"[^>]*>/)![0];
    expect(section(home)).toContain('--block-bg:var(--color-primary)');
    expect(section(about)).toContain('--block-bg:var(--color-secondary)');
  });
});
