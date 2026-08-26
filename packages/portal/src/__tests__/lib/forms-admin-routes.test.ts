// Cookie-auth Forms admin routes: CRUD + submissions + email-action writes.
// Plus the security gate: the API-key (v1 / MCP) write path can NEVER set a
// form's email `actions`.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Site, Form } from '@typeroll/shared';

const ORG = 'default';
const SITE = 'mysite';
const cookies = { get: () => undefined } as any;
const locals = {} as any;

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'test-secret-test-secret-test-secret-1234';
  process.env.INTEGRATIONS_SECRET_KEY = 'test-integrations-secret-test-integrations-secret';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
}

async function seedForm() {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/kontakt`, {
    name: 'Kontakt',
    steps: [{ id: 'main', blocks: [
      { id: 'f-email', type: 'form/email', data: { name: 'email', label: 'E', required: true } },
    ] }],
    actions: [],
    created_at: new Date().toISOString(),
  });
}

async function adminForm(method: 'GET' | 'PUT' | 'DELETE', formId: string, body?: unknown, query = '') {
  const mod = await import('../../pages/api/sites/[siteId]/forms/[formId]/index');
  const req = new Request(`http://localhost/api/sites/${SITE}/forms/${formId}${query}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return (mod as any)[method]({ request: req, cookies, params: { siteId: SITE, formId }, locals }) as Promise<Response>;
}

describe('cookie-auth Forms admin CRUD', () => {
  beforeEach(async () => { await setup(); });

  it('lists forms with submission counts', async () => {
    await seedForm();
    const { getStore } = await import('../../lib/datastore');
    await getStore().addDoc(paths.submissions(ORG, SITE), { form_id: 'kontakt', data: {}, created_at: new Date().toISOString() });
    const mod = await import('../../pages/api/sites/[siteId]/forms/index');
    const res = await mod.GET({ request: new Request(`http://localhost/api/sites/${SITE}/forms`), cookies, params: { siteId: SITE }, locals } as any);
    const body = await res.json();
    expect(body.forms[0].submission_count).toBe(1);
  });

  it('writes email actions via PUT (the admin surface)', async () => {
    await seedForm();
    const res = await adminForm('PUT', 'kontakt', {
      actions: [{ type: 'email', config: { to: '{{email}}', subject: 'Hi', body: '<p>Hi</p>' } }],
    });
    expect(res.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    const form = await getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/kontakt`);
    expect(form!.actions).toHaveLength(1);
    expect((form!.actions[0]!.config as { to: string }).to).toBe('{{email}}');
  });

  it('encrypts webhook secrets and only returns a masked value', async () => {
    await seedForm();
    const res = await adminForm('PUT', 'kontakt', {
      actions: [{ type: 'webhook', config: { url: 'https://8.8.8.8/newsletter', fields: 'email', secret: 'sign-me-please' } }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.form.actions[0].config).toMatchObject({ fields: 'email', secret: '••••••••' });
    expect(body.form.actions[0].config.secret_enc).toBeUndefined();
    const { getStore } = await import('../../lib/datastore');
    const form = await getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/kontakt`);
    expect(String(form!.actions[0]!.config.secret_enc)).toMatch(/^v1\./);
    expect(form!.actions[0]!.config.secret).toBeUndefined();
  });

  it('rejects an email action missing a recipient', async () => {
    await seedForm();
    const res = await adminForm('PUT', 'kontakt', { actions: [{ type: 'email', config: { subject: 's', body: 'b' } }] });
    expect(res.status).toBe(400);
  });

  it('rejects webhook fields that are not declared by the form', async () => {
    await seedForm();
    const res = await adminForm('PUT', 'kontakt', {
      actions: [{ type: 'webhook', config: { url: 'https://8.8.8.8/hook', fields: 'password', secret: 'sign-me' } }],
    });
    expect(res.status).toBe(400);
  });

  it('deletes a form', async () => {
    await seedForm();
    const res = await adminForm('DELETE', 'kontakt');
    expect(res.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(`${paths.forms(ORG, SITE)}/kontakt`)).toBeNull();
  });
});

describe('AI-gate: v1 / MCP write path cannot set email actions', () => {
  beforeEach(async () => { await setup(); });

  async function apiKey(): Promise<string> {
    const { createApiKey } = await import('../../lib/api-keys');
    const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 't', createdBy: 'admin' });
    return token;
  }
  function bearer(t: string) { return { authorization: `Bearer ${t}`, 'content-type': 'application/json' }; }

  it('v1 POST create drops actions', async () => {
    const token = await apiKey();
    const mod = await import('../../pages/api/v1/sites/[siteId]/forms/index');
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/forms`, {
      method: 'POST', headers: bearer(token),
      body: JSON.stringify({
        id: 'lead', name: 'Lead', fields: [{ name: 'email', type: 'email', label: 'E' }],
        actions: [{ type: 'email', config: { to: 'attacker@evil.com', subject: 'x', body: 'y' } }],
      }),
    });
    const res = await mod.POST({ request: req, params: { siteId: SITE } } as any);
    expect(res.status).toBe(201);
    const { getStore } = await import('../../lib/datastore');
    const form = await getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/lead`);
    expect(form!.actions).toEqual([]);
  });

  it('v1 PATCH leaves existing email actions untouched and ignores incoming ones', async () => {
    const token = await apiKey();
    // Admin sets a legitimate email action first.
    await seedForm();
    await adminForm('PUT', 'kontakt', { actions: [{ type: 'email', config: { to: 'owner@site.com', subject: 's', body: 'b' } }] });
    // Now an agent PATCHes via v1 trying to redirect the email.
    const mod = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]');
    const req = new Request(`http://localhost/api/v1/sites/${SITE}/forms/kontakt`, {
      method: 'PATCH', headers: bearer(token),
      body: JSON.stringify({ name: 'Renamed', actions: [{ type: 'email', config: { to: 'attacker@evil.com', subject: 'x', body: 'y' } }] }),
    });
    const res = await mod.PATCH({ request: req, params: { siteId: SITE, formId: 'kontakt' } } as any);
    expect(res.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    const form = await getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/kontakt`);
    expect(form!.name).toBe('Renamed'); // metadata change applied
    expect(form!.actions).toHaveLength(1);
    expect((form!.actions[0]!.config as { to: string }).to).toBe('owner@site.com'); // unchanged
  });
});
