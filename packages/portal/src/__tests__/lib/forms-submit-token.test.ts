// Forms must be embeddable by agents end-to-end:
//
//  1. The v1 API returns `submit_token` + `submit_url` on form read/create,
//     so an agent can build a working embed without portal-cookie access.
//     (Regression: tr-forms documented this contract long before the API
//     implemented it — agents shipped forms that 403'd on every submit.)
//  2. /api/forms/submit accepts plain form-encoded POSTs (hidden `_token`
//     field) and answers with HTML — the no-JS path. The page sanitizer
//     strips inline <script>, so fetch-based embeds can't be assumed.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const SECRET = 'test-secret-test-secret-test-secret-1234';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = SECRET;
  process.env.PORTAL_PUBLIC_URL = 'https://portal.example.com';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  return { token };
}

async function seedForm(id = 'kontakt'): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/${id}`, {
    name: 'Kontakt',
    steps: [{ id: 'main', blocks: [
      { id: 'f-email', type: 'form/email', data: { name: 'email', label: 'E-post', required: true } },
      { id: 'f-message', type: 'form/textarea', data: { name: 'message', label: 'Meddelande' } },
    ] }],
    actions: [],
    success_message: 'Tack! Vi hör av oss.',
    created_at: new Date().toISOString(),
  });
}

async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PATCH', APIRoute>>>,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  params: Record<string, string>,
  init?: { headers?: HeadersInit; body?: unknown },
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string'
    ? JSON.stringify(init.body) : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

async function callSubmit(request: Request): Promise<Response> {
  const mod = await import('../../pages/api/forms/submit');
  return mod.POST({ request } as any) as Promise<Response>;
}

function signedToken(formId = 'kontakt'): Promise<string> {
  return import('../../lib/forms-signing').then(({ signFormToken }) =>
    signFormToken(ORG, SITE, formId));
}

describe('v1 forms expose submit_token + submit_url', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET /forms/{id} returns a token that verifyFormToken accepts', async () => {
    const { token } = await setup();
    await seedForm();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/forms/kontakt`,
      { siteId: SITE, formId: 'kontakt' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { submit_token: string; submit_url: string };
    expect(body.submit_url).toBe('https://portal.example.com/api/forms/submit');
    const { verifyFormToken } = await import('../../lib/forms-signing');
    expect(verifyFormToken(body.submit_token)).toEqual({ orgId: ORG, siteId: SITE, formId: 'kontakt' });
  });

  it('POST /forms (create) returns embed info in the same response', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/forms`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: { id: 'nyhetsbrev', name: 'Nyhetsbrev', fields: [{ name: 'email', type: 'email', label: 'E-post', required: true }] },
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { submit_token: string };
    const { verifyFormToken } = await import('../../lib/forms-signing');
    expect(verifyFormToken(body.submit_token)?.formId).toBe('nyhetsbrev');
  });

  it('submit_token is null (not missing) when FORMS_HMAC_SECRET is absent', async () => {
    const { token } = await setup();
    await seedForm();
    delete process.env.FORMS_HMAC_SECRET;
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/forms/kontakt`,
      { siteId: SITE, formId: 'kontakt' },
      { headers: bearer(token) },
    );
    const body = await res.json() as { submit_token: string | null };
    expect(body.submit_token).toBeNull();
  });
});

describe('/api/forms/submit — JSON protocol', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('accepts { token, data } and stores the submission', async () => {
    await setup();
    await seedForm();
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await signedToken(), data: { email: 'a@b.se', message: 'Hej' } }),
    }));
    expect(res.status).toBe(200);
    // The forms v1 protocol — the only response shape (steps-only model).
    const body = await res.json() as { ok: boolean; done: boolean; message?: string };
    expect(body.ok).toBe(true);
    expect(body.done).toBe(true);
    const { getStore } = await import('../../lib/datastore');
    const subs = await getStore().listDocs(paths.submissions(ORG, SITE));
    expect(subs).toHaveLength(1);
  });

  it('403 JSON on a tampered token', async () => {
    await setup();
    await seedForm();
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: (await signedToken()) + 'x', data: { email: 'a@b.se' } }),
    }));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('/api/forms/submit — plain form POST (no-JS path)', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('accepts urlencoded body with hidden _token, answers HTML with success_message', async () => {
    await setup();
    await seedForm();
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { referer: 'https://gruppsupporter.se/' },
      body: new URLSearchParams({
        _token: await signedToken(),
        _hp: '',
        email: 'a@b.se',
        message: 'Hej',
      }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Tack! Vi hör av oss.');
    // Back link to the page the visitor came from.
    expect(html).toContain('https://gruppsupporter.se/');

    const { getStore } = await import('../../lib/datastore');
    const subs = await getStore().listDocs(paths.submissions(ORG, SITE));
    expect(subs).toHaveLength(1);
    const data = (subs[0] as unknown as { data: Record<string, unknown> }).data;
    expect(data.email).toBe('a@b.se');
    // Reserved underscore fields never reach storage.
    expect(Object.keys(data).some((k) => k.startsWith('_'))).toBe(false);
  });

  it('silently drops honeypot fills (200, nothing stored)', async () => {
    await setup();
    await seedForm();
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      body: new URLSearchParams({ _token: await signedToken(), _hp: 'bot was here', email: 'a@b.se' }),
    }));
    expect(res.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs(paths.submissions(ORG, SITE))).toHaveLength(0);
  });

  it('400 HTML naming the missing required field', async () => {
    await setup();
    await seedForm();
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      body: new URLSearchParams({ _token: await signedToken(), message: 'no email' }),
    }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('E-post');
  });

  it('validation messages follow the site language (sv)', async () => {
    await setup();
    await seedForm();
    const { getStore } = await import('../../lib/datastore');
    const { paths: P } = await import('@typeroll/shared');
    const site = await getStore().getDoc<Record<string, unknown>>(P.site(ORG, SITE));
    await getStore().setDoc(P.site(ORG, SITE), { ...site, language: 'sv' });
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      body: new URLSearchParams({ _token: await signedToken(), message: 'no email' }),
    }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('E-post måste fyllas i');
  });

  it('400 when _token is missing entirely', async () => {
    await setup();
    await seedForm();
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      body: new URLSearchParams({ email: 'a@b.se' }),
    }));
    expect(res.status).toBe(400);
  });

  it('never links back to a javascript: referer', async () => {
    await setup();
    await seedForm();
    const res = await callSubmit(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { referer: 'javascript:alert(1)' },
      body: new URLSearchParams({ _token: await signedToken(), email: 'a@b.se' }),
    }));
    const html = await res.text();
    expect(html).not.toContain('javascript:');
  });
});
