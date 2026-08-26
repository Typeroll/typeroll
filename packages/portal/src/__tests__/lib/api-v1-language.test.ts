// Multilingual fields — language on Site, Page, and SiteSettings.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(siteOver: Partial<Site> = {}): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(), ...siteOver,
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

interface CallInit { headers?: HeadersInit; body?: unknown }
async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH' | 'PUT', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  params: Record<string, string>,
  init?: CallInit,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string' ? JSON.stringify(init.body) : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

describe('Site.language', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('PATCH /sites/{id} accepts a BCP-47 language tag', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { language: 'sv' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { language: string };
    expect(body.language).toBe('sv');
  });

  it('PATCH rejects garbage language tags', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { language: 'svenska_språket' } },
    );
    expect(res.status).toBe(400);
  });

  it('empty string clears language', async () => {
    const { token } = await setup({ language: 'sv' } as Partial<Site>);
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token), body: { language: '' } },
    );
    const body = await res.json() as { language?: string };
    expect(body.language).toBeUndefined();
  });
});

describe('settings.language', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('PATCH /settings allows language', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      { headers: bearer(token), body: { language: 'sv' } },
    );
    expect(res.status).toBe(200);
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID);
    expect((settings as { language?: string } | null)?.language).toBe('sv');
  });
});

describe('Page.language', () => {
  beforeEach(async () => { await resetDatastore(); });

  async function seedPage(): Promise<void> {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: 'home', content_mode: 'html', status: 'published', html_content: '<p>hi</p>',
    });
  }

  it('PATCH /pages/{id} accepts language override', async () => {
    const { token } = await setup();
    await seedPage();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { language: 'en' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { page: { language: string } };
    expect(body.page.language).toBe('en');
  });
});

describe('alt-text-context picks up language', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('uses Site.language and verbalises it (sv → Swedish)', async () => {
    const { token } = await setup({ language: 'sv' } as Partial<Site>);
    const { getStore } = await import('../../lib/datastore');
    const mediaId = await getStore().addDoc(paths.media(ORG, SITE), {
      filename: 'a.jpg', cdn_url: 'https://cdn/a.jpg', mime_type: 'image/jpeg',
      created_at: new Date().toISOString(),
    });
    const mod = await import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/alt-text-context');
    const handler = mod.GET as APIRoute;
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/media/${mediaId}/alt-text-context`, {
      headers: bearer(token),
    });
    const res = await handler({ request: req, params: { siteId: SITE, mediaId }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Response;
    const body = await res.json() as { language: string; suggested_prompt: string };
    expect(body.language).toBe('Swedish');
    expect(body.suggested_prompt).toContain('Swedish');
  });

  it('falls back to settings.language when Site.language unset', async () => {
    const { token } = await setup();
    const { vstore } = await import('../../lib/version-store');
    await vstore.writeSettings(ORG, SITE, MAIN_VERSION_ID, { language: 'de' } as never);
    const { getStore } = await import('../../lib/datastore');
    const mediaId = await getStore().addDoc(paths.media(ORG, SITE), {
      filename: 'a.jpg', cdn_url: 'https://cdn/a.jpg', mime_type: 'image/jpeg',
      created_at: new Date().toISOString(),
    });
    const mod = await import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/alt-text-context');
    const handler = mod.GET as APIRoute;
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/media/${mediaId}/alt-text-context`, {
      headers: bearer(token),
    });
    const res = await handler({ request: req, params: { siteId: SITE, mediaId }, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Response;
    const body = await res.json() as { language: string };
    expect(body.language).toBe('German');
  });
});

describe('settings.apple_touch_icon', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('PATCH /settings persists apple_touch_icon alongside favicon', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/settings'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/settings`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: { favicon: 'https://cdn.example.com/favicon.png', apple_touch_icon: 'https://cdn.example.com/icon-180.png' },
      },
    );
    expect(res.status).toBe(200);
    const { vstore } = await import('../../lib/version-store');
    const settings = await vstore.settings(ORG, SITE, MAIN_VERSION_ID) as { favicon?: string; apple_touch_icon?: string } | null;
    expect(settings?.favicon).toBe('https://cdn.example.com/favicon.png');
    expect(settings?.apple_touch_icon).toBe('https://cdn.example.com/icon-180.png');
  });
});
