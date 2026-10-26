import { afterEach, expect, it, vi } from 'vitest';
import { parseSiteWorkflowRequest, SiteWorkflowInputError } from '../../lib/workflows/create-site';
import { startSiteWorkflow, WorkflowRequestError } from '../../lib/workflows/service';
import { fetchRendered } from '../../lib/wp/page-fetcher';
import { discoverSitemap } from '../../lib/wp/sitemap';
import { linkCheckWorkflow } from '../../lib/workflows/link-check';

afterEach(() => vi.unstubAllGlobals());

it.each(['http://169.254.169.254/', 'http://[::ffff:a9fe:a9fe]/', 'http://127.0.0.1:8080/', 'https://localhost/', 'ftp://example.com/'])(
  'refuses %s as a migration source in every entry point',
  async (wpUrl) => {
    expect(() => parseSiteWorkflowRequest('migration', { name: 'Site', wp_url: wpUrl })).toThrow(SiteWorkflowInputError);
    await expect(startSiteWorkflow({ orgId: 'org', siteId: 'site', type: 'migration', config: { wp_url: wpUrl }, versionId: 'main', createdBy: 'test' }))
      .rejects.toBeInstanceOf(WorkflowRequestError);
  },
);

it('still accepts plain-http public WordPress sources', () => {
  expect(parseSiteWorkflowRequest('migration', { name: 'Site', wp_url: 'http://old.example.com' })).toMatchObject({ wp_url: 'http://old.example.com' });
});

it('does not fetch rendered pages or sitemaps on private addresses, even via redirects', async () => {
  const network = vi.fn(async (input: string | URL) => String(input).includes('public.example')
    ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.8/sitemap.xml' } })
    : new Response('<loc>http://10.0.0.8/a</loc>'));
  vi.stubGlobal('fetch', network);
  expect(await fetchRendered('http://192.168.1.10/page')).toBeNull();
  expect(await discoverSitemap('http://127.0.0.1')).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  expect(await discoverSitemap('https://public.example')).toEqual([]);
  expect(network.mock.calls.every(([url]) => String(url).includes('public.example'))).toBe(true);
});

it('link checking reports private destinations as broken without requesting them', async () => {
  const network = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', network);
  const step = linkCheckWorkflow.steps.find((candidate) => candidate.name === 'verify_links')!;
  const result = await step.run({
    orgId: 'org', siteId: 'site', workflowId: 'wf', store: {} as never, config: {}, log: () => {}, setProgress: () => {},
    state: { links: [
      { page_id: 'p', page_title: 'P', url: 'http://169.254.169.254/latest/meta-data/', text: 'meta' },
      { page_id: 'p', page_title: 'P', url: 'http://[::ffff:7f00:1]:6379/', text: 'redis' },
      { page_id: 'p', page_title: 'P', url: 'https://public.example/', text: 'ok' },
    ] },
  });
  expect((result as { results: { broken_links: Array<{ url: string }> } }).results.broken_links.map((link) => link.url).sort())
    .toEqual(['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:7f00:1]:6379/'].sort());
  expect(network).toHaveBeenCalledTimes(1);
});
