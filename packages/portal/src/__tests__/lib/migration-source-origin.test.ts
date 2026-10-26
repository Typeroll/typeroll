import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { migrationWorkflow } from '../../lib/workflows/migration';
import { mediaTransferAvailability } from '../../lib/wp/media';
import { fetchRendered } from '../../lib/wp/page-fetcher';

const source = vi.hoisted(() => ({ pages: [] as Array<Record<string, unknown>> }));
vi.mock('../../lib/wp/page-fetcher', () => ({ fetchRendered: vi.fn(async () => null), extractMainContent: () => '' }));
vi.mock('../../lib/wp/internal-links', () => ({ extractInternalLinks: () => [], resolveSourceRedirectsInHtml: async (html: string) => html }));
vi.mock('../../lib/wp/client', () => ({ WPClient: class {
  async listItemsOfType() { return []; }
  async listTaxonomies() { return []; }
  async listTerms() { return []; }
  async listPages() { return source.pages; }
  async listPosts() { return []; }
} }));
vi.mock('../../lib/wp/media', () => ({ WPMediaTransfer: vi.fn(), mediaTransferAvailability: vi.fn(), buildMediaMap: () => new Map() }));

const thinPage = (id: number, link: string) => ({ id, title: { rendered: `Page ${id}` }, slug: `page-${id}`, link,
  content: { rendered: '<p>Short</p>' }, date: '2024-05-02T11:01:08', modified: '2024-05-03T11:01:08' });

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('DEPLOY_QUEUE', 'firestore');
  vi.mocked(mediaTransferAvailability).mockResolvedValue({ configured: true, destination: 'organization_r2' } as never);
  vi.mocked(fetchRendered).mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });

it('renders thin pages only from the source site, never from a link the source JSON points elsewhere', async () => {
  source.pages = [
    thinPage(1, 'http://169.254.169.254/latest/meta-data/'),
    thinPage(2, 'http://10.0.0.5/admin/'),
    thinPage(3, 'https://www.wp.example/about/'),
  ];
  const logs: string[] = [];
  await migrationWorkflow.steps.find(step => step.name === 'extract_content')!.run({
    orgId: 'org', siteId: 'site', workflowId: 'import', store: getStore(),
    config: {}, state: { wp_url: 'https://wp.example' }, log: (line: string) => logs.push(line), setProgress: () => {},
  });
  expect(vi.mocked(fetchRendered).mock.calls.map(([url]) => url)).toEqual(['https://www.wp.example/about/']);
  expect(logs.filter(line => line.includes('outside the source site'))).toHaveLength(2);
});
