// Regression tests for the redirect/page consistency rules born out of the
// gruppsupporter incident:
//
//   1. A page slug was changed (home → home-html-legacy), creating the
//      auto-redirect "/" → "/home-html-legacy". A NEW page then took the
//      "/" URL and was published — but the stale redirect stayed, and the
//      deployed `_redirects` 301'd the site root to a draft page (CF Pages
//      serves redirects before static files).
//   2. The old page was later deleted, leaving the auto-redirect pointing
//      at a 404.
//
// The fixes under test: a live page taking a URL retires redirects FROM it
// (slug change / publish / create), and deleting a page removes
// auto-generated redirects TO its URL while keeping manual ones.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Page, Redirect, Site, SiteVersion } from '@typeroll/shared';

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

async function seedPage(id: string, page: Partial<Page>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, status: 'published',
    content_mode: 'html', html_content: '<p>x</p>', ...page,
  });
}

async function seedRedirect(id: string, redirect: Partial<Redirect>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    from_path: '/from', to_path: '/to', status_code: 301, ...redirect,
  });
}

async function listRedirects(): Promise<Redirect[]> {
  const { vstore } = await import('../../lib/version-store');
  return vstore.redirects(ORG, SITE, MAIN_VERSION_ID);
}

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: { headers?: HeadersInit; body?: unknown },
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string'
    ? JSON.stringify(init.body)
    : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}

const bearer = (t: string): HeadersInit => ({ authorization: `Bearer ${t}` });

const pageRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/[pageId]');
const createRoute = () => import('../../pages/api/v1/sites/[siteId]/pages/index');
const pageUrl = (id: string) => `http://localhost/api/v1/sites/${SITE}/pages/${id}`;
const pageParams = (id: string) => ({ siteId: SITE, pageId: id });

describe('redirect hygiene — page writes retire shadowing redirects', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('the gruppsupporter sequence: a published page taking "/" retires the stale auto-redirect', async () => {
    const { token } = await setup();
    await seedPage('home', { slug: 'home' });            // url "/"
    await seedPage('home-new', { slug: 'home-new', status: 'draft', content_mode: 'blocks', blocks: [] });

    // Step 1: page A renamed away from "/" → auto-redirect "/" → "/home-html-legacy".
    const r1 = await callRoute(pageRoute(), 'PATCH', pageUrl('home'), pageParams('home'), {
      headers: bearer(token), body: { slug: 'home-html-legacy', save: true },
    });
    expect(r1.status).toBe(200);
    let redirects = await listRedirects();
    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toMatchObject({
      id: '_', from_path: '/', to_path: '/home-html-legacy', auto_generated: true,
    });

    // Step 2: page B takes "/" and is published — the redirect must retire,
    // or the deploy would 301 the site root away from the new home page.
    const r2 = await callRoute(pageRoute(), 'PATCH', pageUrl('home-new'), pageParams('home-new'), {
      headers: bearer(token), body: { slug: 'home', status: 'published', save: true },
    });
    expect(r2.status).toBe(200);
    const out = await r2.json() as { retired_redirects: Array<{ from_path: string }> };
    expect(out.retired_redirects).toEqual([{ from_path: '/', to_path: '/home-html-legacy' }]);

    redirects = await listRedirects();
    // The "/" redirect is gone; the rename of home-new created its own
    // auto-redirect from "/home-new" which is fine (no page owns that URL).
    expect(redirects.map((r) => r.from_path)).toEqual(['/home-new']);
  });

  it('a slug change on a DRAFT page does not retire redirects (they may still serve traffic)', async () => {
    const { token } = await setup();
    await seedPage('landing', { slug: 'landing', status: 'draft' });
    await seedRedirect('_old-landing', { from_path: '/old-landing', to_path: '/elsewhere' });

    const res = await callRoute(pageRoute(), 'PATCH', pageUrl('landing'), pageParams('landing'), {
      headers: bearer(token), body: { slug: 'old-landing' },
    });
    expect(res.status).toBe(200);
    expect((await listRedirects()).some((r) => r.from_path === '/old-landing')).toBe(true);
  });

  it('publishing a page (status-only change) retires a redirect from its URL', async () => {
    const { token } = await setup();
    await seedPage('landing', { slug: 'landing', status: 'draft' });
    await seedRedirect('_landing', { from_path: '/landing', to_path: '/elsewhere', auto_generated: true });

    const res = await callRoute(pageRoute(), 'PATCH', pageUrl('landing'), pageParams('landing'), {
      headers: bearer(token), body: { status: 'published' },
    });
    expect(res.status).toBe(200);
    expect(await listRedirects()).toHaveLength(0);
  });

  it('manual redirects retire too when a published page takes their from_path — a real page beats a redirect', async () => {
    const { token } = await setup();
    await seedPage('p', { slug: 'p', status: 'draft' });
    await seedRedirect('_offers', { from_path: '/offers', to_path: '/old-offers' }); // no auto_generated flag

    const res = await callRoute(pageRoute(), 'PATCH', pageUrl('p'), pageParams('p'), {
      headers: bearer(token), body: { slug: 'offers', status: 'published', save: true },
    });
    expect(res.status).toBe(200);
    expect((await listRedirects()).some((r) => r.from_path === '/offers')).toBe(false);
  });

  it('creating a published page retires a shadowing redirect; creating a draft does not', async () => {
    const { token } = await setup();
    await seedRedirect('_kampanj', { from_path: '/kampanj', to_path: '/x', auto_generated: true });
    await seedRedirect('_utkast', { from_path: '/utkast', to_path: '/y', auto_generated: true });

    const r1 = await callRoute(createRoute(), 'POST', `http://localhost/api/v1/sites/${SITE}/pages`, { siteId: SITE }, {
      headers: bearer(token), body: { title: 'Kampanj', slug: 'kampanj', status: 'published' },
    });
    expect(r1.status).toBe(201);
    const out = await r1.json() as { retired_redirects: Array<{ from_path: string }> };
    expect(out.retired_redirects).toEqual([{ from_path: '/kampanj', to_path: '/x' }]);

    const r2 = await callRoute(createRoute(), 'POST', `http://localhost/api/v1/sites/${SITE}/pages`, { siteId: SITE }, {
      headers: bearer(token), body: { title: 'Utkast', slug: 'utkast' },  // default draft
    });
    expect(r2.status).toBe(201);

    const remaining = (await listRedirects()).map((r) => r.from_path);
    expect(remaining).toEqual(['/utkast']);
  });
});

describe('redirect hygiene — page delete cleans up inbound auto-redirects', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('removes auto-generated redirects targeting the deleted page, keeps manual + unrelated ones', async () => {
    const { token } = await setup();
    await seedPage('services', { slug: 'services' });
    await seedRedirect('_old-services', {
      from_path: '/old-services', to_path: '/services', auto_generated: true,
    });
    await seedRedirect('_svc', { from_path: '/svc', to_path: '/services' }); // manual — keep
    await seedRedirect('_other', { from_path: '/a', to_path: '/b', auto_generated: true }); // unrelated — keep

    const res = await callRoute(pageRoute(), 'DELETE', pageUrl('services'), pageParams('services'), {
      headers: bearer(token),
    });
    expect(res.status).toBe(200);
    const out = await res.json() as { removed_redirects: Array<{ from_path: string }> };
    expect(out.removed_redirects).toEqual([{ from_path: '/old-services', to_path: '/services' }]);

    const remaining = (await listRedirects()).map((r) => r.from_path).sort();
    expect(remaining).toEqual(['/a', '/svc']);
  });
});
