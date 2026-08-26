// Coverage for the Push 1 + Push 2 feedback fixes:
//  - public URL projection on site reads
//  - sanitization_warnings on partial / page writes
//  - auto_redirects on slug change
//  - ?summary= on list_partials + list_collection_items
//  - Forms CRUD + submissions listing

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
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

async function seedPage(id: string, doc: Record<string, unknown>): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.pages(ORG, SITE, MAIN_VERSION_ID)}/${id}`, {
    title: id, slug: id, content_mode: 'html', status: 'published', html_content: '<p>seed</p>', ...doc,
  });
}

describe('public URLs on site reads', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET /v1/sites/{id} returns urls with production=null when no domain', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { urls: { production: string | null } };
    expect(body.urls.production).toBeNull();
  });

  it('GET /v1/sites/{id} returns urls with production set when site.domain is DNS-verified', async () => {
    // A bare domain without verified status no longer counts as production
    // (that was the "fresh site shows Live" bug) — DNS must be confirmed.
    const { token } = await setup({ domain: 'www.example.se', domain_status: 'verified' } as Partial<Site>);
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { urls: { production: string } };
    expect(body.urls.production).toBe('https://www.example.se');
  });
});

describe('sanitization_warnings on writes', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('PATCH /pages/{id} surfaces stripped <script> count', async () => {
    const { token } = await setup();
    await seedPage('home', { html_content: '<p>safe</p>' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { html_content: '<p>hi</p><script>alert(1)</script>' } },
    );
    const body = await res.json() as { sanitization_warnings: string[]; page: { html_content: string } };
    expect(body.sanitization_warnings.some((w) => w.includes('script'))).toBe(true);
    expect(body.page.html_content).not.toContain('<script');
  });

  it('clean input produces no warnings', async () => {
    const { token } = await setup();
    await seedPage('home', {});
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/home`,
      { siteId: SITE, pageId: 'home' },
      { headers: bearer(token), body: { html_content: '<p>just text</p>' } },
    );
    const body = await res.json() as { sanitization_warnings: string[] };
    expect(body.sanitization_warnings).toEqual([]);
  });
});

describe('auto_redirects on slug change', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('PATCH that changes slug writes a 301 from the old path', async () => {
    const { token } = await setup();
    await seedPage('about', { slug: 'about' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/about`,
      { siteId: SITE, pageId: 'about' },
      { headers: bearer(token), body: { slug: 'om-oss', save: true } },
    );
    const body = await res.json() as { auto_redirects: Array<{ from_path: string; to_path: string }> };
    expect(body.auto_redirects).toHaveLength(1);
    expect(body.auto_redirects[0].from_path).toBe('/about');
    expect(body.auto_redirects[0].to_path).toBe('/om-oss');

    // Verify the redirect doc actually landed.
    const { vstore } = await import('../../lib/version-store');
    const redirects = await vstore.redirects(ORG, SITE, MAIN_VERSION_ID);
    expect(redirects.some((r) => r.from_path === '/about' && r.to_path === '/om-oss')).toBe(true);
  });

  it('does NOT double-write when a redirect already exists from the old path', async () => {
    const { token } = await setup();
    await seedPage('about', { slug: 'about' });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(
      `${paths.redirects(ORG, SITE, MAIN_VERSION_ID)}/_about`,
      { from_path: '/about', to_path: '/somewhere-else', status_code: 301 },
    );
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/about`,
      { siteId: SITE, pageId: 'about' },
      { headers: bearer(token), body: { slug: 'om-oss', save: true } },
    );
    const body = await res.json() as { auto_redirects: Array<{ from_path: string }> };
    expect(body.auto_redirects).toEqual([]);
  });

  it('does NOT redirect when slug is unchanged', async () => {
    const { token } = await setup();
    await seedPage('about', { slug: 'about' });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/pages/[pageId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/pages/about`,
      { siteId: SITE, pageId: 'about' },
      { headers: bearer(token), body: { html_content: '<p>updated</p>' } },
    );
    const body = await res.json() as { auto_redirects: unknown[] };
    expect(body.auto_redirects).toEqual([]);
  });
});

describe('?summary= on list_partials', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('drops html_content but keeps a byte count', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/cta`, {
      name: 'CTA', kind: 'free', status: 'published', html_content: '<p>' + 'x'.repeat(2000) + '</p>',
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/partials?summary=true`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { partials: Array<{ html_content?: string; html_content_bytes: number }> };
    expect(body.partials[0].html_content).toBeUndefined();
    expect(body.partials[0].html_content_bytes).toBeGreaterThan(2000);
  });

  it('without summary, returns the full content', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.partials(ORG, SITE, MAIN_VERSION_ID)}/cta`, {
      name: 'CTA', kind: 'free', status: 'published', html_content: '<p>hi</p>',
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/partials/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/partials`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { partials: Array<{ html_content: string }> };
    expect(body.partials[0].html_content).toBe('<p>hi</p>');
  });
});

describe('Forms CRUD', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('POST / creates a form with validated fields', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/forms`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          id: 'contact',
          name: 'Contact us',
          fields: [
            { name: 'name', type: 'text', label: 'Name', required: true },
            { name: 'email', type: 'email', label: 'Email', required: true },
            { name: 'message', type: 'textarea', label: 'Message' },
          ],
        },
      },
    );
    expect(res.status).toBe(201);
    // fields[] is authoring sugar — the stored model is one static step of
    // form/* blocks (steps-only storage).
    const body = await res.json() as { form: { id: string; steps: Array<{ id: string; blocks: unknown[] }> } };
    expect(body.form.id).toBe('contact');
    expect(body.form.steps).toHaveLength(1);
    expect(body.form.steps[0].blocks).toHaveLength(3);
  });

  it('POST rejects invalid field types', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/forms`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          id: 'bad',
          name: 'Bad',
          fields: [{ name: 'sneaky', type: 'sql-injection', label: 'x' }],
        },
      },
    );
    expect(res.status).toBe(400);
  });

  it('POST rejects select/radio fields without options', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/forms`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          id: 'survey',
          name: 'Survey',
          fields: [{ name: 'cat', type: 'select', label: 'Category' }],
        },
      },
    );
    expect(res.status).toBe(400);
  });

  it('POST rejects duplicate field names', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/forms`,
      { siteId: SITE },
      {
        headers: bearer(token),
        body: {
          id: 'dup',
          name: 'Dup',
          fields: [
            { name: 'email', type: 'email', label: 'Email A' },
            { name: 'email', type: 'email', label: 'Email B' },
          ],
        },
      },
    );
    expect(res.status).toBe(400);
  });

  it('POST 409 on duplicate id', async () => {
    const { token } = await setup();
    const make = () =>
      callRoute(
        import('../../pages/api/v1/sites/[siteId]/forms/index'),
        'POST',
        `http://localhost/api/v1/sites/${SITE}/forms`,
        { siteId: SITE },
        {
          headers: bearer(token),
          body: {
            id: 'contact',
            name: 'Contact',
            fields: [{ name: 'email', type: 'email', label: 'Email' }],
          },
        },
      );
    await make();
    const second = await make();
    expect(second.status).toBe(409);
  });

  it('PATCH updates writable fields', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
      name: 'Old', fields: [{ name: 'email', type: 'email', label: 'Email' }],
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]'),
      'PATCH',
      `http://localhost/api/v1/sites/${SITE}/forms/contact`,
      { siteId: SITE, formId: 'contact' },
      { headers: bearer(token), body: { name: 'New', submit_text: 'Send it' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { form: { name: string; submit_text: string } };
    expect(body.form.name).toBe('New');
    expect(body.form.submit_text).toBe('Send it');
  });

  it('DELETE keeps submissions by default, drops with delete_submissions', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
      name: 'Contact', fields: [{ name: 'email', type: 'email', label: 'Email' }],
    });
    await getStore().addDoc(paths.submissions(ORG, SITE), {
      form_id: 'contact', data: { email: 'a@b' }, created_at: new Date().toISOString(),
    });
    await getStore().addDoc(paths.submissions(ORG, SITE), {
      form_id: 'other-form', data: {}, created_at: new Date().toISOString(),
    });

    // Default: leave submissions.
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/forms/contact`,
      { siteId: SITE, formId: 'contact' },
      { headers: bearer(token) },
    );
    const after = await getStore().listDocs(paths.submissions(ORG, SITE));
    expect(after.length).toBe(2);

    // Recreate then delete with the cleanup flag.
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
      name: 'Contact', fields: [{ name: 'email', type: 'email', label: 'Email' }],
    });
    await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/forms/contact?delete_submissions=true`,
      { siteId: SITE, formId: 'contact' },
      { headers: bearer(token) },
    );
    const final = await getStore().listDocs(paths.submissions(ORG, SITE));
    expect(final.length).toBe(1);
    expect((final[0] as unknown as { form_id: string }).form_id).toBe('other-form');
  });

  it('GET /{formId}/submissions returns newest first, scoped to that form', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
      name: 'Contact', fields: [{ name: 'email', type: 'email', label: 'Email' }],
    });
    await getStore().addDoc(paths.submissions(ORG, SITE), {
      form_id: 'contact', data: { email: 'a@b' }, created_at: '2026-01-01T00:00:00Z',
    });
    await getStore().addDoc(paths.submissions(ORG, SITE), {
      form_id: 'contact', data: { email: 'b@c' }, created_at: '2026-01-02T00:00:00Z',
    });
    await getStore().addDoc(paths.submissions(ORG, SITE), {
      form_id: 'other', data: {}, created_at: '2026-01-03T00:00:00Z',
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/forms/contact/submissions`,
      { siteId: SITE, formId: 'contact' },
      { headers: bearer(token) },
    );
    const body = await res.json() as { submissions: Array<{ data: { email?: string }; created_at: string }> };
    expect(body.submissions).toHaveLength(2);
    expect(body.submissions[0].created_at).toBe('2026-01-02T00:00:00Z');
  });

  it('GET /{formId}/submissions 404 for unknown form', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/forms/nope/submissions`,
      { siteId: SITE, formId: 'nope' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /{formId}/submissions/{submissionId}', () => {
  beforeEach(async () => { await resetDatastore(); });

  async function seedFormWithSubmissions(): Promise<{ token: string; keepId: string; dropId: string }> {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
      name: 'Contact', fields: [{ name: 'email', type: 'email', label: 'Email' }],
    });
    const dropId = await getStore().addDoc(paths.submissions(ORG, SITE), {
      form_id: 'contact', data: { email: 'test@test' }, created_at: '2026-01-01T00:00:00Z',
    });
    const keepId = await getStore().addDoc(paths.submissions(ORG, SITE), {
      form_id: 'contact', data: { email: 'real@lead' }, created_at: '2026-01-02T00:00:00Z',
    });
    return { token, keepId, dropId };
  }

  it('401 without a bearer token', async () => {
    const { dropId } = await seedFormWithSubmissions();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions/[submissionId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/forms/contact/submissions/${dropId}`,
      { siteId: SITE, formId: 'contact', submissionId: dropId },
    );
    expect(res.status).toBe(401);
  });

  it('deletes only the targeted submission', async () => {
    const { token, keepId, dropId } = await seedFormWithSubmissions();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions/[submissionId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/forms/contact/submissions/${dropId}`,
      { siteId: SITE, formId: 'contact', submissionId: dropId },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deleted_submission_id: string };
    expect(body.ok).toBe(true);
    expect(body.deleted_submission_id).toBe(dropId);

    const { getStore } = await import('../../lib/datastore');
    const remaining = await getStore().listDocs(paths.submissions(ORG, SITE));
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as unknown as { id: string }).id).toBe(keepId);
  });

  it('404 for unknown form', async () => {
    const { token, dropId } = await seedFormWithSubmissions();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions/[submissionId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/forms/nope/submissions/${dropId}`,
      { siteId: SITE, formId: 'nope', submissionId: dropId },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
  });

  it('404 for unknown submission id', async () => {
    const { token } = await seedFormWithSubmissions();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions/[submissionId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/forms/contact/submissions/missing`,
      { siteId: SITE, formId: 'contact', submissionId: 'missing' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
  });

  it('404 when the submission belongs to a different form — nothing deleted', async () => {
    const { token, dropId } = await seedFormWithSubmissions();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/other`, {
      name: 'Other', fields: [{ name: 'email', type: 'email', label: 'Email' }],
    });
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions/[submissionId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/forms/other/submissions/${dropId}`,
      { siteId: SITE, formId: 'other', submissionId: dropId },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
    const remaining = await getStore().listDocs(paths.submissions(ORG, SITE));
    expect(remaining).toHaveLength(2);
  });
});
