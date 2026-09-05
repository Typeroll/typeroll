// Tool handler tests. Each handler maps to one REST call; we assert the
// shape of the request (method, URL, body) and that the handler bubbles
// the response through ok().

import { describe, it, expect } from 'vitest';
import { TyperollClient } from '../src/client.js';
import { pageTools } from '../src/tools/pages.js';
import { partialTools } from '../src/tools/partials.js';
import { bulkTools } from '../src/tools/bulk.js';
import { previewTools } from '../src/tools/preview.js';
import { siteTools } from '../src/tools/sites.js';
import { blockTypeTools } from '../src/tools/block-types.js';
import { settingsTools } from '../src/tools/settings.js';
import { collectionTools } from '../src/tools/collections.js';
import { mediaTools } from '../src/tools/media.js';
import { migrationTools } from '../src/tools/migration.js';

interface Recorded {
  method: string;
  url: string;
  body: string | null;
}

function setup(responder: (req: Recorded) => Response | Promise<Response>): {
  client: TyperollClient;
  siteId: string;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? init.body : null;
    const method = init?.method ?? 'GET';
    const call: Recorded = { method, url, body };
    calls.push(call);
    return responder(call);
  };
  const client = new TyperollClient({
    baseUrl: 'https://example.test',
    apiKey: 'typeroll_live_aaaa_bbbb',
    fetchImpl,
  });
  return { client, siteId: 'mysite', calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function find<T>(tools: T[], name: string): T {
  const t = (tools as Array<{ name: string }>).find((x) => x.name === name) as T | undefined;
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe('pages tools', () => {
  it('list_pages forwards filters as query params', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ pages: [] }));
    const tool = find(pageTools, 'list_pages') as typeof pageTools[number];
    const result = await tool.handler({ status: 'draft', limit: 10 } as never, { client, siteId });
    expect(result.isError).toBeFalsy();
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/pages?status=draft&limit=10');
  });

  it('read_page URL-encodes the page id', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ page: { id: 'a b' } }));
    const tool = find(pageTools, 'read_page');
    await tool.handler({ page_id: 'a b' } as never, { client, siteId });
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/pages/a%20b');
  });

  it('batch_read_pages POSTs page_ids', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ pages: [] }));
    const tool = find(pageTools, 'batch_read_pages');
    await tool.handler({ page_ids: ['a', 'b'] } as never, { client, siteId });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/pages/batch-read');
    expect(calls[0].body).toBe(JSON.stringify({ page_ids: ['a', 'b'] }));
  });

  it('update_page PATCHes only the patch field, not the version', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ page: {} }));
    const tool = find(pageTools, 'update_page');
    await tool.handler(
      { page_id: 'home', patch: { title: 'New' }, version: 'feature' } as never,
      { client, siteId },
    );
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/pages/home?version=feature');
    expect(calls[0].body).toBe(JSON.stringify({ title: 'New' }));
  });

  it('returns isError on 4xx with the API error body surfaced', async () => {
    const { client, siteId } = setup(() => jsonResponse({ error: 'Not found' }, 404));
    const tool = find(pageTools, 'read_page');
    const result = await tool.handler({ page_id: 'nope' } as never, { client, siteId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not found');
    expect(result.content[0].text).toContain('"status": 404');
  });
});

describe('collection and media tool contracts', () => {
  it('uses collection consistently while retaining name as a compatibility alias', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ collection: {} }));
    const tool = find(collectionTools, 'read_collection');
    await tool.handler({ collection: 'news' } as never, { client, siteId });
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/collections/news');
    await tool.handler({ name: 'legacy' } as never, { client, siteId });
    expect(calls[1].url).toBe('https://example.test/api/v1/sites/mysite/collections/legacy');
  });

  it('exposes a bounded batch URL upload tool', () => {
    const tool = find(mediaTools, 'upload_media_batch_from_urls');
    expect(tool.description).toContain('1–50');
    expect(tool.inputSchema).toHaveProperty('items');
  });
});

describe('migration tool contracts', () => {
  it('POSTs proposed compositions to the readiness preflight', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ ready: true }));
    const tool = find(migrationTools, 'get_migration_readiness');
    const compositions = [{
      name: 'Article',
      fields: [{ name: 'body', type: 'richtext' }],
      blocks: [{ id: 'body', type: 'template/item_body', data: { field: 'body' } }],
    }];
    await tool.handler({ source_url: 'https://old.example.com', compositions } as never, { client, siteId });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://example.test/api/v1/sites/mysite/migration-preflight',
      body: JSON.stringify({ source_url: 'https://old.example.com', compositions }),
    });
  });

  it('bulk-updates URL decisions in one PATCH', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ updated: 2 }));
    const tool = find(migrationTools, 'update_migration_urls');
    await tool.handler({ ids: ['a', 'b'], patch: { excluded: true } } as never, { client, siteId });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://example.test/api/v1/sites/mysite/migration-urls',
      body: JSON.stringify({ ids: ['a', 'b'], patch: { excluded: true } }),
    });
  });

  it('imports an explicit sitemap URL through the dedicated route', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ discovered: 3 }));
    const tool = find(migrationTools, 'import_sitemap');
    await tool.handler({ url: 'https://old.example.com/custom.xml' } as never, { client, siteId });
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/migration-urls/import-sitemap');
  });

  it('defaults the WordPress plain-text repair to dry-run', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ dry_run: true, diffs: [] }));
    const tool = find(migrationTools, 'repair_migration_plain_text');
    await tool.handler({ scope: 'pages', fields: ['title'] } as never, { client, siteId });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://example.test/api/v1/sites/mysite/migration-urls/repair-plain-text',
      body: JSON.stringify({ scope: 'pages', fields: ['title'], dry_run: true }),
    });
    expect(tool.description).toContain('ALWAYS run the dry-run first');
  });
});

describe('partials tools', () => {
  it('find_pages_using_block GETs the usage path', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ pages: [] }));
    const tool = find(partialTools, 'find_pages_using_block');
    await tool.handler({ partial_id: 'cta' } as never, { client, siteId });
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/partials/cta/usage');
  });

  it('create_free_block POSTs the new block', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ partial: {} }));
    const tool = find(partialTools, 'create_free_block');
    await tool.handler(
      { id: 'newsletter-cta', html_content: '<p>x</p>' } as never,
      { client, siteId },
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/partials');
    expect(calls[0].body).toContain('newsletter-cta');
  });

  it('set_partial_mode POSTs the revision-safe mode endpoint', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ content_mode: 'blocks' }));
    const tool = find(partialTools, 'set_partial_mode');
    await tool.handler({ partial_id: 'header', to: 'blocks' } as never, { client, siteId });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://example.test/api/v1/sites/mysite/partials/header/mode',
      body: JSON.stringify({ to: 'blocks', convert: false }),
    });
  });
});

describe('sites tools', () => {
  it('create_site POSTs name + domain to the root /v1/sites endpoint', async () => {
    const { client, siteId, calls } = setup(() =>
      jsonResponse({ site: { id: 'acme', name: 'Acme' } }, 201),
    );
    const tool = find(siteTools, 'create_site');
    const result = await tool.handler({ name: 'Acme', domain: 'acme.com' } as never, { client, siteId });
    expect(result.isError).toBeFalsy();
    expect(calls[0].method).toBe('POST');
    // Root URL — NOT site-scoped: the new site doesn't exist yet.
    expect(calls[0].url).toBe('https://example.test/api/v1/sites');
    expect(calls[0].body).toBe(JSON.stringify({ name: 'Acme', domain: 'acme.com' }));
  });

  it('create_site is site-less (noSite) so the hosted transport omits site_id', () => {
    expect(find(siteTools, 'create_site').noSite).toBe(true);
  });

  it('surfaces the 403 when a site-scoped key tries to create', async () => {
    const { client, siteId } = setup(() =>
      jsonResponse({ error: 'Creating sites requires an org-scoped API key.' }, 403),
    );
    const tool = find(siteTools, 'create_site');
    const result = await tool.handler({ name: 'Acme' } as never, { client, siteId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('org-scoped');
    expect(result.content[0].text).toContain('"status": 403');
  });
});

describe('block-types tools', () => {
  const sample = {
    block_types: [
      {
        id: 'core/section',
        label: 'Section',
        category: 'layout',
        origin: 'core',
        schema: [{ name: 'width', type: 'select', label: 'Width' }],
        template: '<section data-block="section">{{children}}</section>',
        styles: '[data-block="section"]{padding:2rem}',
        script: 'console.log("x")',
      },
    ],
  };

  it('list_block_types returns a summary that drops template/styles/script but keeps the field schema', async () => {
    const { client, siteId } = setup(() => jsonResponse(sample));
    const tool = find(blockTypeTools, 'list_block_types');
    const result = await tool.handler({} as never, { client, siteId });
    const text = result.content[0].text;
    expect(text).toContain('"id": "core/section"');
    expect(text).toContain('"schema"'); // field schema retained — needed for add_block
    expect(text).toContain('"width"');
    expect(text).not.toContain('template');
    expect(text).not.toContain('styles');
    expect(text).not.toContain('script');
  });

  it('list_block_types full:true inlines template + styles + script', async () => {
    const { client, siteId } = setup(() => jsonResponse(sample));
    const tool = find(blockTypeTools, 'list_block_types');
    const result = await tool.handler({ full: true } as never, { client, siteId });
    const text = result.content[0].text;
    expect(text).toContain('"template"');
    expect(text).toContain('"styles"');
    expect(text).toContain('"script"');
  });

  it('list_block_types forwards include_core=false and version as query params', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ block_types: [] }));
    const tool = find(blockTypeTools, 'list_block_types');
    await tool.handler({ include_core: false, version: 'feat' } as never, { client, siteId });
    expect(calls[0].url).toContain('/api/v1/sites/mysite/block-types?');
    expect(calls[0].url).toContain('version=feat');
    expect(calls[0].url).toContain('include_core=false');
  });
});

describe('bulk + preview tools', () => {
  it('bulk_replace_text passes through dry_run', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ dry_run: true }));
    const tool = find(bulkTools, 'bulk_replace_text');
    await tool.handler(
      { pattern: '299 kr', replacement: '349 kr', dry_run: true } as never,
      { client, siteId },
    );
    expect(calls[0].body).toBe(JSON.stringify({ pattern: '299 kr', replacement: '349 kr', dry_run: true }));
  });

  it('get_preview_link mints via POST /preview-link', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ url: 'https://x', expires_at: '2030-01-01' }));
    const tool = find(previewTools, 'get_preview_link');
    await tool.handler({ page_id: 'home', ttl_seconds: 300 } as never, { client, siteId });
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/preview-link');
    expect(calls[0].body).toContain('"page_id":"home"');
  });
});

describe('settings tools — branch (version) support', () => {
  it('read_site_settings forwards version as ?version=', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ settings: {} }));
    const tool = find(settingsTools, 'read_site_settings');
    await tool.handler({ version: 'redesign-1' } as never, { client, siteId });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/settings?version=redesign-1');
  });

  it('read_site_settings without version hits main (no query)', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ settings: {} }));
    const tool = find(settingsTools, 'read_site_settings');
    await tool.handler({} as never, { client, siteId });
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/settings');
  });

  it('update_site_settings scopes the PATCH to ?version= and strips version from the body', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ ok: true }));
    const tool = find(settingsTools, 'update_site_settings');
    await tool.handler({ version: 'redesign-1', colors: { primary: '#123456' } } as never, { client, siteId });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/settings?version=redesign-1');
    const body = JSON.parse(calls[0].body!);
    expect(body).toEqual({ colors: { primary: '#123456' } });
    expect(body).not.toHaveProperty('version');
  });

  it('update_site_settings without version writes main (no query, no version field)', async () => {
    const { client, siteId, calls } = setup(() => jsonResponse({ ok: true }));
    const tool = find(settingsTools, 'update_site_settings');
    await tool.handler({ site_name: 'Acme' } as never, { client, siteId });
    expect(calls[0].url).toBe('https://example.test/api/v1/sites/mysite/settings');
    expect(JSON.parse(calls[0].body!)).toEqual({ site_name: 'Acme' });
  });
});
