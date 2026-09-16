import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { migrationWorkflow } from '../../lib/workflows/migration';
import { reconstructPage } from '../../lib/wp/ai-reconstruct';
import { mediaTransferAvailability } from '../../lib/wp/media';

const source = vi.hoisted(() => ({ categories: [] as number[], terms: [] as Array<Record<string, unknown>>, customItems: [] as Array<Record<string, unknown>> }));
vi.mock('../../lib/wp/page-fetcher', () => ({ fetchRendered: async () => null, extractMainContent: () => '' }));
vi.mock('../../lib/wp/client', () => ({ WPClient: class {
    async listItemsOfType() { return source.customItems; }
    async listTaxonomies() { return source.terms.length ? [{ slug: 'category', name: 'Categories', rest_base: 'categories', types: ['post'], hierarchical: true }] : []; }
    async listTerms() { return source.terms; }
    async listPages() { return [{ id: 1, title: { rendered: 'About' }, slug: 'about', link: 'https://wp.example/about/', content: { rendered: '<h2 id="welcome">Welcome</h2><p>Original content</p>' }, date: '2026-01-01', modified: '2026-01-02' }]; }
    async listPosts() { return [{ id: 2, categories: source.categories, title: { rendered: 'Article' }, slug: 'article', link: 'https://wp.example/news/article/', content: { rendered: '<figure class="wp-block-table"><table><tr><th>Header</th></tr><tr><td>Value</td></tr></table></figure>' }, date: '2026-01-01', modified: '2026-01-02' }]; }
  } }));
vi.mock('../../lib/wp/ai-reconstruct', () => ({ reconstructPage: vi.fn(), isAIReconstructAvailable: () => false }));
vi.mock('../../lib/wp/media', () => ({ WPMediaTransfer: vi.fn(), mediaTransferAvailability: vi.fn(), buildMediaMap: () => new Map() }));

beforeEach(async () => {
  source.categories = []; source.terms = []; source.customItems = [];
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('DEPLOY_QUEUE', 'firestore');
  vi.mocked(reconstructPage).mockImplementation(async (_design, input) => ({ html: input.cleaned_html, used_ai: false }));
  vi.mocked(mediaTransferAvailability).mockResolvedValue({ configured: true, destination: 'organization_r2' } as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['blocks', 'html'])('imports both WordPress pages and posts through the real workflow in %s mode into the selected version', async mode => {
  const store = getStore();
  await store.setDoc(paths.version('org', 'site', 'redesign'), { kind: 'branch', base_version_id: 'main' });
  await store.setDoc(paths.page('org', 'site', 'main-only', 'main'), { title: 'Keep main unchanged', content_mode: 'html', html_content: '<p>Main</p>' });
  const result = await migrationWorkflow.steps.find(step => step.name === 'extract_content')!.run({
    orgId: 'org', siteId: 'site', workflowId: 'import', store,
    config: { version: 'redesign', target_content_mode: mode }, state: { wp_url: 'https://wp.example' }, log: () => {}, setProgress: () => {},
  });
  expect(reconstructPage).not.toHaveBeenCalled();
  expect(result).toMatchObject({ state: { imported_count: 2 } });
  const pages = await store.listDocs(paths.pages('org', 'site', 'redesign'));
  expect(pages).toHaveLength(2);
  expect(pages.find(page => page.id === 'wp-page-1')).toMatchObject({ content_type: 'page', path: '/about', content_mode: mode, status: 'review' });
  const post = pages.find(page => page.id === 'wp-post-2');
  expect(post).toMatchObject({ content_type: 'posts', path: '/news/article', content_mode: mode, status: 'review' });
  if (mode === 'blocks') {
    expect(post).not.toHaveProperty('html_content');
    expect(JSON.stringify(post)).toContain('core/table');
    expect(JSON.stringify(pages)).toContain('welcome');
  } else expect(post).toHaveProperty('html_content');
  expect(await store.getDoc(paths.page('org', 'site', 'main-only', 'main'))).toMatchObject({ title: 'Keep main unchanged', html_content: '<p>Main</p>' });
  expect(await store.listDocs(paths.contentTypes('org', 'site', 'main'))).toHaveLength(0);
  expect(await store.listDocs(paths.contentTypes('org', 'site', 'redesign'))).toHaveLength(2);
  expect(await store.listDocs(paths.pageTemplates('org', 'site', 'redesign'))).toHaveLength(1);
});

async function runImport() {
  return migrationWorkflow.steps.find(step => step.name === 'extract_content')!.run({
    orgId: 'org', siteId: 'site', workflowId: 'import', store: getStore(),
    config: {}, state: { wp_url: 'https://wp.example' }, log: () => {}, setProgress: () => {},
  });
}

it('imports shared categories once and preserves saved edits on retry', async () => {
  source.categories = [5];
  source.terms = [{ id: 5, name: 'Packing &amp; moving', slug: 'packing', link: 'https://wp.example/category/packing/', meta: { emoji: '📦' } }];
  await runImport();
  const store = getStore();
  const categoryPath = paths.page('org', 'site', 'wp-term-category-5');
  const articlePath = paths.page('org', 'site', 'wp-post-2');
  const category = await store.getDoc(categoryPath);
  expect(category).toMatchObject({ title: 'Packing & moving', path: '/category/packing', fields: { meta_emoji: '📦' } });
  expect(await store.getDoc(articlePath)).toMatchObject({ fields: { wp_taxonomy_category: ['wp-term-category-5'] } });
  expect(JSON.stringify(await store.getDoc(articlePath))).not.toContain('📦');
  expect(await store.getDoc(paths.contentType('org', 'site', 'posts'))).toMatchObject({ fields: expect.arrayContaining([
    { name: 'wp_taxonomy_category', label: 'Categories', type: 'page_ref_list', ref_content_type: 'wp_taxonomy_category' },
  ]) });
  await store.setDoc(categoryPath, { ...category, title: 'Edited shared category' });
  await store.setDoc(articlePath, { ...(await store.getDoc(articlePath)), title: 'Edited article', status: 'published' });
  expect(await runImport()).toMatchObject({ state: { skipped_existing: 2, shared_terms: 1 } });
  expect(await store.listDocs(paths.pages('org', 'site'))).toHaveLength(3);
  expect(await store.getDoc(categoryPath)).toHaveProperty('title', 'Edited shared category');
  expect(await store.getDoc(articlePath)).toMatchObject({ title: 'Edited article', status: 'published' });
});

it('fails before importing pages when a referenced term is missing', async () => {
  source.categories = [999];
  source.terms = [{ id: 5, name: 'Packing', slug: 'packing', link: 'https://wp.example/category/packing/' }];
  await expect(runImport()).rejects.toThrow('Missing term category:999');
  expect(await getStore().listDocs(paths.pages('org', 'site'))).toHaveLength(0);
});

it('refuses to replace an existing unrelated page at the same URL', async () => {
  await getStore().setDoc(paths.page('org', 'site', 'hand-written'), { title: 'Existing', path: '/news/article/' });
  await expect(runImport()).rejects.toThrow('Import conflicts with existing page hand-written');
  expect(await getStore().listDocs(paths.pages('org', 'site'))).toHaveLength(1);
});

it('checks URL coverage against the imported branch instead of main', async () => {
  const store = getStore();
  await store.setDoc(paths.version('org', 'site', 'redesign'), { kind: 'branch', base_version_id: 'main' });
  await migrationWorkflow.steps.find(step => step.name === 'extract_content')!.run({
    orgId: 'org', siteId: 'site', workflowId: 'import', store,
    config: { version: 'redesign' }, state: { wp_url: 'https://wp.example' }, log: () => {}, setProgress: () => {},
  });
  for (const page of await store.listDocs(paths.pages('org', 'site', 'redesign'))) {
    await store.updateDoc(paths.page('org', 'site', page.id, 'redesign'), { status: 'published' });
  }
  const { analyzeCoverage } = await import('../../lib/wp/url-inventory');
  expect((await analyzeCoverage(store, 'org', 'site', 'redesign')).summary.migrated).toBe(2);
  expect((await analyzeCoverage(store, 'org', 'site', 'main')).summary.migrated).toBe(0);
});

it('uses the same body, custom-field and SEO rules for custom post types', async () => {
  const store = getStore();
  source.customItems = [{ id: 3, slug: 'news-item', link: 'https://wp.example/news/item/', title: { rendered: 'Custom news' },
    content: { rendered: '<h2>Original heading</h2><p>Original body</p>' }, acf: { promoted: true },
    date: '2026-01-01', modified: '2026-01-02', menu_order: 7, _seo: { title: 'Custom SEO', description: 'Original description', noindex: true },
  }];
  const result = await migrationWorkflow.steps.find(step => step.name === 'extract_content')!.run({
    orgId: 'org', siteId: 'site', workflowId: 'import', store, config: {},
    state: { wp_url: 'https://wp.example', content_types_created: [{ source_slug: 'news', source_rest_base: 'news-items', name: 'news', item_field: 'body' }] },
    log: () => {}, setProgress: () => {},
  });
  expect(result).toMatchObject({ state: { imported_count: 3 } });
  expect(await store.getDoc(paths.page('org', 'site', 'wp-news-3'))).toMatchObject({
    content_type: 'news', fields: { promoted: true }, seo_title: 'Custom SEO', seo_description: 'Original description', noindex: true, sort_order: 7,
    content_mode: 'blocks', status: 'review',
  });
  expect(reconstructPage).not.toHaveBeenCalled();
});

it('requires updated helper support and never silently falls back after helper authorization fails', async () => {
  const ctx = { orgId: 'org', siteId: 'site', workflowId: 'import', store: getStore(),
    config: { wp_url: 'https://wp.example', helper_api_key: 'test-only-key' }, state: {}, log: () => {}, setProgress: () => {} };
  const discover = migrationWorkflow.steps.find(step => step.name === 'discover')!;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ plugin_version: '0.3.1' })));
  await expect(discover.run(ctx)).rejects.toThrow('Update Typeroll Helper');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
  await expect(discover.run(ctx)).rejects.toThrow('403');
});
