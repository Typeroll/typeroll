import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { migrationWorkflow } from '../../lib/workflows/migration';
import { mediaTransferAvailability } from '../../lib/wp/media';
import { fetchRendered } from '../../lib/wp/page-fetcher';

const source = vi.hoisted(() => ({ helperPosts: [] as Array<Record<string, unknown>>, restPages: [] as Array<Record<string, unknown>> }));
vi.mock('../../lib/wp/page-fetcher', () => ({ fetchRendered: vi.fn(async () => null), extractMainContent: () => '' }));
vi.mock('../../lib/wp/internal-links', () => ({ extractInternalLinks: () => [], resolveSourceRedirectsInHtml: async (html: string) => html }));
vi.mock('../../lib/wp/client', () => ({ WPClient: class {
  async listItemsOfType() { return []; }
  async listTaxonomies() { return []; }
  async listTerms() { return []; }
  async listPages() { return source.restPages; }
  async listPosts() { return []; }
} }));
vi.mock('../../lib/wp/helper-client', () => ({ WPHelperClient: class {
  async listItems(type: string) { return type === 'post' ? source.helperPosts : []; }
  async listTaxonomies() { return []; }
  async listTerms() { return []; }
} }));
vi.mock('../../lib/wp/media', () => ({ WPMediaTransfer: vi.fn(), mediaTransferAvailability: vi.fn(), buildMediaMap: () => new Map() }));

const body = '<p>' + 'Public article text. '.repeat(20) + '</p>';
const helperPost = (id: number, slug: string, isProtected: boolean) => ({
  id, type: 'post', slug, status: 'publish', protected: isProtected, title: { rendered: slug },
  content: { rendered: isProtected ? '' : body, raw: '' }, excerpt: { rendered: '' },
  date: '2024-05-02T11:01:08Z', modified: '2024-05-03T11:01:08Z', link: `https://wp.example/${slug}/`,
  parent: 0, menu_order: 0, author: 1, featured_image: null, taxonomies: {}, meta: {}, acf: {}, builder: null,
});

async function extract(state: Record<string, unknown>) {
  const logs: string[] = [];
  const result = await migrationWorkflow.steps.find(step => step.name === 'extract_content')!.run({
    orgId: 'org', siteId: 'site', workflowId: 'import', store: getStore(),
    config: {}, state: { wp_url: 'https://wp.example', ...state }, log: (line: string) => logs.push(line), setProgress: () => {},
  });
  const pages = await getStore().listDocs<{ id: string }>(paths.pages('org', 'site'));
  return { logs, state: (result as { state: Record<string, unknown> }).state, pageIds: pages.map(page => page.id).sort() };
}

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('DEPLOY_QUEUE', 'firestore');
  vi.mocked(mediaTransferAvailability).mockResolvedValue({ configured: true, destination: 'organization_r2' } as never);
  vi.mocked(fetchRendered).mockClear();
  source.helperPosts = []; source.restPages = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

it('skips password-protected helper items instead of importing an empty or password-form page', async () => {
  source.helperPosts = [helperPost(1, 'news', false), helperPost(2, 'members', true)];
  const { logs, state, pageIds } = await extract({ helper_active: true, helper_api_key: 'test-only-key' });
  expect(pageIds).toEqual(['wp-post-1']);
  expect(state.imported_count).toBe(1);
  expect(state.protected_skipped).toEqual([{ source_type: 'post', id: 2, url: 'https://wp.example/members/' }]);
  expect(logs.some(line => line.startsWith('[members] Password-protected'))).toBe(true);
  // The thin-content fallback must not render the source's password form either.
  expect(vi.mocked(fetchRendered)).not.toHaveBeenCalled();
});

it('skips items WordPress REST marks as protected', async () => {
  source.restPages = [{ id: 7, slug: 'private-page', status: 'publish', title: { rendered: 'Private' }, link: 'https://wp.example/private-page/',
    content: { rendered: '', protected: true }, date: '2024-05-02T11:01:08', modified: '2024-05-03T11:01:08' }];
  const { state, pageIds } = await extract({});
  expect(pageIds).toEqual([]);
  expect(state.protected_skipped).toEqual([{ source_type: 'page', id: 7, url: 'https://wp.example/private-page/' }]);
  expect(vi.mocked(fetchRendered)).not.toHaveBeenCalled();
});
