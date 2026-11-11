// Preview derives app data exactly as the next publication would: from the
// accepted, published content, through the same providers, with a receipt.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MAIN_VERSION_ID, paths, CORE_BLOCK_TYPES } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const state = vi.hoisted(() => ({ providers: [] as any[] }));
vi.mock('../../lib/publishing/derivation-providers', async (original) => ({
  ...(await original<typeof import('../../lib/publishing/derivation-providers')>()),
  derivationProvidersFor: vi.fn(async () => state.providers),
}));

const ORG = 'orgone';
const SITE = 'derivesite';
const SECRET = 'a-very-long-secret-string-at-least-32-chars-x';
const scope = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };

/** A generic provider: one fact per company, from its accepted fields only. */
function provider(calls: any[], { fail = false } = {}) {
  return {
    id: 'synthetic-install', version: '1.2.3', required: true, config: {}, sources: ['example.facts'],
    request: async (input: any) => {
      calls.push(input);
      if (fail) throw new Error('provider is down');
      const { derivationInputDigest } = await import('../../lib/publishing/build-derivation');
      const companies = input.content.pages.filter((page: any) => page.content_type === 'company');
      return { input_digest: derivationInputDigest(input), receipts: [{ kind: 'records', id: 'company', count: companies.length }], sources: [
        { id: 'example.facts', records: companies.map((page: any) => ({ id: page.id, text: `training:${page.fields.support.training}` })) },
      ] };
    },
  };
}

async function seed() {
  process.env.PREVIEW_HMAC_SECRET = SECRET;
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'Derive', created_at: new Date().toISOString() });
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
  await store.setDoc(paths.settings(ORG, SITE), { site_name: 'Derive', trailing_slash: 'always', render_version: 16 });
  await store.setDoc(paths.contentType(ORG, SITE, 'company'), { id: 'company', name: 'company', route_template: '/{slug}/', fields: [
    { name: 'support', type: 'object', label: 'Support', fields: [{ name: 'training', type: 'boolean' }] },
    { name: 'private_note', type: 'text', rendered: false },
  ] });
  await store.setDoc(`${paths.blockTypes(ORG, SITE)}/fact-item`, { id: 'fact-item', label: 'Fact', schema: [], template: '<p class="fact">{{item.text}}</p>' });
  await store.setDoc(`${paths.blockTypes(ORG, SITE)}/dataset`, { id: 'dataset', label: 'Dataset', schema: [], template: '<div data-dataset="{{site.derived_data_url}}"></div>' });
  await store.setDoc(paths.page(ORG, SITE, 'acme'), { title: 'Acme', slug: 'acme', content_type: 'company', status: 'published', content_mode: 'blocks',
    fields: { support: { training: false }, private_note: 'PRIVATE-SENTINEL' },
    blocks: [
      { id: 'facts', type: 'core/repeater', data: { source_type: 'derived', derived_source: 'example.facts', item_block: 'fact-item' } },
      { id: 'data', type: 'dataset', data: {} },
    ] });
  await store.setDoc(paths.page(ORG, SITE, 'draft-co'), { title: 'Draft', slug: 'draft-co', content_type: 'company', status: 'draft', content_mode: 'blocks',
    fields: { support: { training: true } }, blocks: [] });
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' })).token;
}

async function call(route: Promise<Partial<Record<'GET' | 'POST', APIRoute>>>, method: 'GET' | 'POST', url: string, params: Record<string, string>, init: { headers?: HeadersInit; body?: unknown } = {}) {
  const handler = (await route)[method]!;
  const request = new Request(url, { method, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return handler({ request, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

beforeEach(async () => {
  state.providers = [];
  (await import('../../lib/publishing/preview-derivation')).clearPreviewDerivationCache();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('previewDerivation', () => {
  it('derives from the accepted public content a publication would freeze, and reuses only identical input', async () => {
    await seed();
    const calls: any[] = [];
    state.providers = [provider(calls)];
    const { mergeWorkingCopy } = await import('../../lib/working-copy');
    await mergeWorkingCopy(scope, { kind: 'page', id: 'acme' }, { title: 'WORKING-SENTINEL', fields: { support: { training: true } } }, 'editor');
    const { previewDerivation } = await import('../../lib/publishing/preview-derivation');

    const first = await previewDerivation(ORG, SITE, MAIN_VERSION_ID);
    expect(first.status).toBe('succeeded');
    expect(first.derived).toEqual({ 'example.facts': [{ id: 'acme', text: 'training:false' }] });
    expect(first.data_digest).toBe(createHash('sha256').update(first.data!).digest('hex'));
    expect(first.receipts).toEqual([{ kind: 'records', id: 'company', count: 1 }]);
    expect(Object.keys(first.cache_keys)).toEqual(['synthetic-install']);
    // Drafts, working copies and private fields never reach the provider.
    const sent = JSON.stringify(calls[0]);
    for (const leak of ['WORKING-SENTINEL', 'PRIVATE-SENTINEL', 'draft-co']) expect(sent).not.toContain(leak);

    // The content revision is the digest the publication computes for the same content.
    const { resolvePublicationVersion } = await import('../../lib/publishing/publication-version');
    const { publicationContentDigest } = await import('../../lib/publishing/derivation-providers');
    const { projectStaticPublication } = await import('../../../../../scripts/lib/static-publication.mjs');
    const resolved = await resolvePublicationVersion(ORG, SITE, MAIN_VERSION_ID);
    const frozen = projectStaticPublication({ ...resolved, site: { name: 'Derive', domain: 'derive.example' }, media: [], forms: [], extensions: [] },
      { siteUrl: 'https://derive.example', coreCommit: 'b'.repeat(40), publishedAt: '2026-11-09T00:00:00Z', noindex: false, coreBlockTypes: CORE_BLOCK_TYPES });
    expect(first.content_revision).toBe(publicationContentDigest({ version_id: resolved.versionId, pages: frozen.pages, content_types: frozen.contentTypes }));

    const again = await previewDerivation(ORG, SITE, MAIN_VERSION_ID);
    expect(again.reused).toBe(true);
    expect(calls).toHaveLength(1);

    // Accepted content changed: a new revision, derived again, never the old result.
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.page(ORG, SITE, 'acme'), { fields: { support: { training: true }, private_note: 'PRIVATE-SENTINEL' } });
    const changed = await previewDerivation(ORG, SITE, MAIN_VERSION_ID);
    expect(changed.reused).toBe(false);
    expect(changed.content_revision).not.toBe(first.content_revision);
    expect(changed.derived['example.facts']).toEqual([{ id: 'acme', text: 'training:true' }]);
    expect(calls).toHaveLength(2);
  });

  it('reports a failed derivation with its reason and retries it next time', async () => {
    await seed();
    const calls: any[] = [];
    state.providers = [provider(calls, { fail: true })];
    const { previewDerivation } = await import('../../lib/publishing/preview-derivation');
    const failed = await previewDerivation(ORG, SITE, MAIN_VERSION_ID);
    expect(failed).toMatchObject({ status: 'failed', data_digest: null, derived: {}, error: { provider: 'synthetic-install' } });
    expect(failed.error!.message).toContain('provider is down');
    await previewDerivation(ORG, SITE, MAIN_VERSION_ID);
    expect(calls).toHaveLength(2);
  });

  it('reports none and freezes nothing for a page view on a site without deriving apps', async () => {
    await seed();
    const { previewDerivation } = await import('../../lib/publishing/preview-derivation');
    expect(await previewDerivation(ORG, SITE, MAIN_VERSION_ID, { contentRevision: false })).toMatchObject({ status: 'none', content_revision: '', data_digest: null });
    expect((await previewDerivation(ORG, SITE, MAIN_VERSION_ID)).content_revision).toMatch(/^[a-f0-9]{32}$/);
  });

  it('keeps previews working when the publication runtime is refused, and says so only to deriving apps', async () => {
    await seed();
    vi.stubEnv('FORMS_PUBLIC_URL', 'http://localhost:4321');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, { name: 'Contact', steps: [], created_at: new Date().toISOString() });
    const { previewDerivation } = await import('../../lib/publishing/preview-derivation');
    expect(await previewDerivation(ORG, SITE, MAIN_VERSION_ID)).toMatchObject({ status: 'none' });
    state.providers = [provider([])];
    const refused = await previewDerivation(ORG, SITE, MAIN_VERSION_ID);
    expect(refused).toMatchObject({ status: 'failed', error: { provider: 'publication' } });
    expect(refused.error!.message).toContain('must use HTTPS');
  });
});

describe('preview links and the preview route', () => {
  async function link(apiKey: string, body: Record<string, unknown> = {}) {
    const res = await call(import('../../pages/api/v1/sites/[siteId]/preview-link'), 'POST', `http://localhost/api/v1/sites/${SITE}/preview-link`, { siteId: SITE },
      { headers: { authorization: `Bearer ${apiKey}` }, body: { slug: 'acme', ...body } });
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  }
  const frame = (url: string) => call(import('../../pages/preview/[siteId]/[...slug]'), 'GET', `${url}&frame=1&bridge=${crypto.randomUUID()}`,
    { siteId: SITE, slug: new URL(url).pathname.replace(`/preview/${SITE}/`, '') });

  it('reports what a link shows and renders derived listings and the dataset URL', async () => {
    const apiKey = await seed();
    state.providers = [provider([])];
    const current = await link(apiKey);
    const upgrade = await link(apiKey, { render_version: 15 });
    expect(current).toMatchObject({ render_version: 16, site_render_version: 16, derivation: { status: 'succeeded', receipts: [{ kind: 'records', id: 'company', count: 1 }] } });
    expect(current.content_revision).toMatch(/^[a-f0-9]{32}$/);
    expect(current.derivation).not.toHaveProperty('data');
    expect(current.derivation).not.toHaveProperty('derived');
    // Comparable: the same content and derived data at both render versions.
    expect(upgrade.render_version).toBe(15);
    expect(upgrade.content_revision).toBe(current.content_revision);
    expect(upgrade.derivation.data_digest).toBe(current.derivation.data_digest);

    const res = await frame(current.url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<p class="fact">training:false</p>');
    expect(res.headers.get('x-typeroll-preview-state')).toBeNull();
    expect(html).not.toContain('typeroll-preview-state');
    expect(html).toContain('"action":"preview.notices","notices":[]');
    const dataUrl = html.match(/data-dataset="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    expect(dataUrl).toContain(`/preview/${SITE}/_typeroll/derived/${current.derivation.data_digest}.json?t=`);

    const dataset = await call(import('../../pages/preview/[siteId]/[...slug]'), 'GET', dataUrl!, { siteId: SITE, slug: `_typeroll/derived/${current.derivation.data_digest}.json` });
    expect(dataset.status).toBe(200);
    expect(dataset.headers.get('access-control-allow-origin')).toBe('*');
    expect(await dataset.json()).toEqual({ 'example.facts': [{ id: 'acme', text: 'training:false' }] });

    const stale = await call(import('../../pages/preview/[siteId]/[...slug]'), 'GET', dataUrl!.replace(current.derivation.data_digest, 'f'.repeat(64)), { siteId: SITE, slug: `_typeroll/derived/${'f'.repeat(64)}.json` });
    expect(stale.status).toBe(409);
  });

  it('says when content changed after the link was made', async () => {
    const apiKey = await seed();
    state.providers = [provider([])];
    const current = await link(apiKey);
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.page(ORG, SITE, 'acme'), { fields: { support: { training: true } } });
    const res = await frame(current.url);
    const html = await res.text();
    expect(res.headers.get('x-typeroll-preview-state')).toBe('content-changed');
    expect(html).toContain('<meta name="typeroll-preview-state" content="content-changed">');
    expect(html).toContain('<p class="fact">training:true</p>');
    // Nothing in the page's flow: the notice must not shift frame screenshots.
    const body = html.slice(html.search(/<body[^>]*>/i));
    expect(body).not.toContain('Content changed since');
    expect(body).not.toMatch(/position:\s*sticky/);
    expect(html.slice(0, html.search(/<\/head>/i))).toContain('"kind":"content-changed"');
  });

  it('shows a failed derivation instead of empty listings', async () => {
    const apiKey = await seed();
    state.providers = [provider([], { fail: true })];
    const current = await link(apiKey);
    expect(current.derivation).toMatchObject({ status: 'failed', error: { provider: 'synthetic-install' } });
    const res = await frame(current.url);
    const html = await res.text();
    expect(res.headers.get('x-typeroll-preview-state')).toBe('derivation-failed');
    expect(html).toMatch(/<meta name="typeroll-preview-notice" data-kind="derivation-failed" content="[^"]*provider is down/);
    expect(html.slice(html.search(/<body[^>]*>/i))).not.toContain('provider is down');
  });
});
