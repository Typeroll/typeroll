import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { migrationWorkflow } from '../../lib/workflows/migration';
import { reconstructPage } from '../../lib/wp/ai-reconstruct';
import { mediaTransferAvailability } from '../../lib/wp/media';

vi.mock('../../lib/wp/client', () => ({ WPClient: class {
    async listPages() { return [{ id: 1, title: { rendered: 'About' }, slug: 'about', link: 'https://wp.example/about/', content: { rendered: '<h2 id="welcome">Welcome</h2><p>Original content</p>' }, date: '2026-01-01', modified: '2026-01-02' }]; }
    async listPosts() { return [{ id: 2, title: { rendered: 'Article' }, slug: 'article', link: 'https://wp.example/news/article/', content: { rendered: '<figure class="wp-block-table"><table><tr><th>Header</th></tr><tr><td>Value</td></tr></table></figure>' }, date: '2026-01-01', modified: '2026-01-02' }]; }
  } }));
vi.mock('../../lib/wp/ai-reconstruct', () => ({ reconstructPage: vi.fn(), isAIReconstructAvailable: () => false }));
vi.mock('../../lib/wp/media', () => ({ WPMediaTransfer: vi.fn(), mediaTransferAvailability: vi.fn(), buildMediaMap: () => new Map() }));

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('DEPLOY_QUEUE', 'firestore');
  vi.mocked(reconstructPage).mockImplementation(async (_design, input) => ({ html: input.cleaned_html, used_ai: false }));
  vi.mocked(mediaTransferAvailability).mockResolvedValue({ configured: true, destination: 'organization_r2' } as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each(['blocks', 'html'])('imports both WordPress pages and posts through the real workflow in %s mode into the selected version', async mode => {
  const store = getStore();
  await store.setDoc(paths.version('org', 'site', 'redesign'), { kind: 'branch', base_version_id: 'main' });
  await store.setDoc(paths.page('org', 'site', 'wp-page-1', 'main'), { title: 'Keep main unchanged', content_mode: 'html', html_content: '<p>Main</p>' });
  const result = await migrationWorkflow.steps.find(step => step.name === 'extract_content')!.run({
    orgId: 'org', siteId: 'site', workflowId: 'import', store,
    config: { version: 'redesign', target_content_mode: mode }, state: { wp_url: 'https://wp.example' }, log: () => {}, setProgress: () => {},
  });
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
  expect(await store.getDoc(paths.page('org', 'site', 'wp-page-1', 'main'))).toMatchObject({ title: 'Keep main unchanged', html_content: '<p>Main</p>' });
  expect(await store.listDocs(paths.contentTypes('org', 'site', 'main'))).toHaveLength(0);
  expect(await store.listDocs(paths.contentTypes('org', 'site', 'redesign'))).toHaveLength(1);
  expect(await store.listDocs(paths.pageTemplates('org', 'site', 'redesign'))).toHaveLength(1);
});
