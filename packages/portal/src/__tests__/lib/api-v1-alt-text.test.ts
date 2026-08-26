// GET /v1/sites/{id}/media/{mediaId}/alt-text-context — provides
// the agent with image_url + tuned prompt + page-usage context so it
// can run vision in its own model.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string; mediaId: string }> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'Acme Movers', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const mediaId = await getStore().addDoc(paths.media(ORG, SITE), {
    filename: 'hero.jpg',
    cdn_url: 'https://cdn.example.com/orgs/orgone/sites/mysite/images/hero.jpg',
    mime_type: 'image/jpeg',
    created_at: new Date().toISOString(),
  });
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token, mediaId };
}

interface CallInit { headers?: HeadersInit }
async function callGet(
  url: string,
  params: Record<string, string>,
  init?: CallInit,
): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/alt-text-context');
  const handler = mod.GET as APIRoute;
  const req = new Request(url, { method: 'GET', headers: init?.headers });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

describe('alt-text-context', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns image_url + suggested_prompt + language', async () => {
    const { token, mediaId } = await setup();
    const res = await callGet(
      `http://localhost/api/v1/sites/${SITE}/media/${mediaId}/alt-text-context`,
      { siteId: SITE, mediaId },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      image_url: string;
      suggested_prompt: string;
      language: string;
      used_on_pages: unknown[];
    };
    expect(body.image_url).toBe('https://cdn.example.com/orgs/orgone/sites/mysite/images/hero.jpg');
    expect(body.suggested_prompt).toContain('alt-text');
    expect(body.suggested_prompt).toContain('Acme Movers');
    expect(body.language).toBe('English'); // default when settings.language unset
    expect(body.used_on_pages).toEqual([]);
  });

  it('picks up settings.language so vision writes in the right language', async () => {
    const { token, mediaId } = await setup();
    const { vstore } = await import('../../lib/version-store');
    await vstore.writeSettings(ORG, SITE, MAIN_VERSION_ID, { language: 'Swedish' } as never);
    const res = await callGet(
      `http://localhost/api/v1/sites/${SITE}/media/${mediaId}/alt-text-context`,
      { siteId: SITE, mediaId },
      { headers: bearer(token) },
    );
    const body = await res.json() as { language: string; suggested_prompt: string };
    expect(body.language).toBe('Swedish');
    expect(body.suggested_prompt).toContain('Swedish');
  });

  it('finds pages that use the image and surfaces the nearest heading', async () => {
    const { token, mediaId } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/home`, {
      title: 'Home', slug: 'home', content_mode: 'html', status: 'published',
      html_content:
        '<section><h1>Welcome to Acme</h1><h2>Our services</h2>' +
        '<p>We move you anywhere.</p>' +
        '<img src="https://cdn.example.com/orgs/orgone/sites/mysite/images/hero.jpg" /></section>',
    });
    const res = await callGet(
      `http://localhost/api/v1/sites/${SITE}/media/${mediaId}/alt-text-context`,
      { siteId: SITE, mediaId },
      { headers: bearer(token) },
    );
    const body = await res.json() as { used_on_pages: Array<{ page_id: string; nearest_heading?: string }> };
    expect(body.used_on_pages).toHaveLength(1);
    expect(body.used_on_pages[0].page_id).toBe('home');
    expect(body.used_on_pages[0].nearest_heading).toBe('Our services');
  });

  it('reports current alt-text so the agent can decide whether to overwrite', async () => {
    const { token, mediaId } = await setup();
    const { getStore } = await import('../../lib/datastore');
    // Patch in a current alt text
    const path = `${paths.media(ORG, SITE)}/${mediaId}`;
    const existing = await getStore().getDoc(path);
    await getStore().setDoc(path, { ...(existing as Record<string, unknown>), alt_text: 'Existing alt' });
    const res = await callGet(
      `http://localhost/api/v1/sites/${SITE}/media/${mediaId}/alt-text-context`,
      { siteId: SITE, mediaId },
      { headers: bearer(token) },
    );
    const body = await res.json() as { current_alt_text: string | null };
    expect(body.current_alt_text).toBe('Existing alt');
  });

  it('404 for unknown media', async () => {
    const { token } = await setup();
    const res = await callGet(
      `http://localhost/api/v1/sites/${SITE}/media/nope/alt-text-context`,
      { siteId: SITE, mediaId: 'nope' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
  });
});
