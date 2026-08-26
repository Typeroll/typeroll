// Wildcard redirects end-to-end: write guard → coverage → emitted file.
//
// A WordPress migration retires whole URL families (`/category/*`,
// `/2019/*`), so the three layers have to agree: the rule is accepted, the
// inventory counts the URLs it covers, and the deploy emits it in an order
// where it can actually fire.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Page, Redirect, Site, SiteVersion } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import { buildRedirectsFile } from '../../lib/deploy/runner';
import { partitionShadowedRedirects } from '../../lib/redirect-hygiene';
import { checkRedirectWrite, redirectDocId } from '../../lib/redirect-write';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({
    orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com',
  });
  return { token };
}

async function seedPage(id: string, doc: Partial<Page>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, status: 'published', content_mode: 'html', html_content: '', ...doc,
  });
}

describe('checkRedirectWrite', () => {
  beforeEach(async () => { await setup(); });

  it('accepts a wildcard that only covers dead URLs', async () => {
    await seedPage('om-oss', {});
    const res = await checkRedirectWrite({
      orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID,
      from_path: '/category/*', to_path: '/blogg/:splat',
    });
    expect(res.ok).toBe(true);
  });

  it('refuses a wildcard that would hide live pages, naming them', async () => {
    await seedPage('blogg_hej', { slug: 'hej', path: '/blogg/hej' });
    await seedPage('blogg_da', { slug: 'da', path: '/blogg/da' });
    const res = await checkRedirectWrite({
      orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID,
      from_path: '/blogg/*', to_path: '/nyheter/:splat',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('/blogg/hej');
    expect(res.error).toContain('/blogg/da');
    expect(res.error).toContain('Narrow the pattern');
  });

  it('ignores draft pages — they produce no file to shadow', async () => {
    await seedPage('blogg_utkast', { slug: 'utkast', path: '/blogg/utkast', status: 'draft' });
    const res = await checkRedirectWrite({
      orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID,
      from_path: '/blogg/*', to_path: '/nyheter/:splat',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a malformed pattern before it can be silently dropped by Cloudflare', async () => {
    const res = await checkRedirectWrite({
      orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID,
      from_path: '/blog/*/kommentarer', to_path: '/x',
    });
    expect(res.ok).toBe(false);
  });
});

describe('redirectDocId', () => {
  it('keeps a splat rule and a placeholder rule distinct', () => {
    // The old derivation mapped both "*" and ":" to "_", so writing one
    // would silently overwrite the other.
    expect(redirectDocId('/blogg/*')).not.toBe(redirectDocId('/blogg/:slug'));
  });

  it('is stable for a plain path', () => {
    expect(redirectDocId('/om-oss')).toBe('om-oss');
  });
});

describe('v1 redirects route', () => {
  let token: string;
  beforeEach(async () => { ({ token } = await setup()); });

  async function post(body: unknown): Promise<Response> {
    const mod = await import('../../pages/api/v1/sites/[siteId]/redirects/index');
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/redirects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return mod.POST!({ request: req, params: { siteId: SITE }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
  }

  it('creates a wildcard rule', async () => {
    const res = await post({ from_path: '/category/*', to_path: '/blogg/:splat' });
    expect(res.status).toBe(201);
  });

  it('400s a pattern whose target references an undeclared capture', async () => {
    const res = await post({ from_path: '/blog/:slug', to_path: '/artiklar/:year' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(':year');
  });

  it('400s a rule that would hide a live page', async () => {
    await seedPage('blogg_hej', { slug: 'hej', path: '/blogg/hej' });
    const res = await post({ from_path: '/blogg/*', to_path: '/nyheter/:splat' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('/blogg/hej');
  });
});

describe('coverage with wildcards', () => {
  beforeEach(async () => { await setup(); });

  it('counts pattern-covered inventory URLs as redirected, with a resolved target', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { addInventoryUrls, analyzeCoverage } = await import('../../lib/wp/url-inventory');
    await addInventoryUrls(getStore(), ORG, SITE, [
      { url: '/category/mat' },
      { url: '/category/mat/recept' },
      { url: '/kontakt' },
    ]);
    await getStore().setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/cat`, {
      from_path: '/category/*', to_path: '/blogg/:splat', status_code: 301,
    } satisfies Partial<Redirect>);

    const { urls, summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(summary.redirected).toBe(2);
    expect(summary.unhandled).toBe(1);
    const recept = urls.find((u) => u.path === '/category/mat/recept');
    expect(recept?.target).toBe('/blogg/mat/recept');
  });

  it('lets an exact rule win over a pattern that also matches', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { addInventoryUrls, analyzeCoverage } = await import('../../lib/wp/url-inventory');
    await addInventoryUrls(getStore(), ORG, SITE, [{ url: '/category/mat' }]);
    await getStore().setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/cat`, {
      from_path: '/category/*', to_path: '/blogg/:splat', status_code: 301,
    } satisfies Partial<Redirect>);
    await getStore().setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/mat`, {
      from_path: '/category/mat', to_path: '/mat-och-dryck', status_code: 301,
    } satisfies Partial<Redirect>);

    const { urls } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(urls[0].target).toBe('/mat-och-dryck');
  });

  it('still lets a real page win over a pattern', async () => {
    const { getStore } = await import('../../lib/datastore');
    const { addInventoryUrls, analyzeCoverage } = await import('../../lib/wp/url-inventory');
    await addInventoryUrls(getStore(), ORG, SITE, [{ url: '/category/mat' }]);
    await seedPage('category_mat', { slug: 'mat', path: '/category/mat' });
    await getStore().setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/cat`, {
      from_path: '/category/*', to_path: '/blogg/:splat', status_code: 301,
    } satisfies Partial<Redirect>);

    const { summary } = await analyzeCoverage(getStore(), ORG, SITE);
    expect(summary.migrated).toBe(1);
    expect(summary.redirected).toBe(0);
  });
});

describe('emitted _redirects', () => {
  it('orders narrow rules before broad ones — Cloudflare stops at the first match', () => {
    const file = buildRedirectsFile(null, [
      { from_path: '/blogg/*', to_path: '/nyheter/:splat', status_code: 301 },
      { from_path: '/blogg/recept/*', to_path: '/mat/:splat', status_code: 301 },
      { from_path: '/blogg/recept/pannkakor', to_path: '/mat/pannkakor', status_code: 301 },
    ]);
    expect(file).toBe(
      '/blogg/recept/pannkakor /mat/pannkakor 301\n' +
      '/blogg/recept/* /mat/:splat 301\n' +
      '/blogg/* /nyheter/:splat 301\n',
    );
  });

  it('keeps the host-level apex/www rule first', () => {
    const file = buildRedirectsFile(
      { domain: 'example.com', domain_alias: 'www.example.com' } as Site,
      [{ from_path: '/category/*', to_path: '/blogg/:splat', status_code: 301 }],
    );
    expect(file!.split('\n')[0]).toContain('https://www.example.com/*');
  });
});

describe('deploy-time shadow guard', () => {
  it('drops a wildcard that captures a page published after the rule was written', () => {
    const rules = [
      { from_path: '/blogg/*', to_path: '/nyheter/:splat' },
      { from_path: '/category/*', to_path: '/blogg/:splat' },
    ];
    const { kept, shadowed, shadowedPages } = partitionShadowedRedirects(
      rules,
      new Set(['/', '/blogg/hej']),
    );
    expect(kept.map((r) => r.from_path)).toEqual(['/category/*']);
    expect(shadowed).toHaveLength(1);
    expect(shadowedPages.get(shadowed[0])).toEqual(['/blogg/hej']);
  });
});
