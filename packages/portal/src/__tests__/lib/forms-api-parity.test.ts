// The v1 API (and so MCP) offers what the portal's Forms UI does, with the
// same permission rules: form capabilities, reading one submission, webhook
// delivery status for admins, and deletes that also clear delivery records.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { Form, Site } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'default';
const SITE = 'mysite';
const auth = vi.hoisted(() => ({ permission: 'admin' as string, extension: false }));

vi.mock('../../lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-auth')>();
  return {
    ...actual,
    requireApiKey: async (request: Request, siteId: string) => ({
      ok: true,
      value: {
        orgId: ORG, tokenOrgId: ORG, tokenSiteId: siteId, siteId, versionId: 'main',
        site: { id: siteId, name: 'My Site' }, keyPrefix: 'test', permission: auth.permission,
        request, path: new URL(request.url).pathname,
        ...(auth.extension ? { extensionIdentity: { installationId: 'app-one', scopes: ['forms:read', 'forms:write', 'submissions:read'] } } : {}),
      },
    }),
  };
});

const cookies = { get: () => undefined } as never;
const locals = {} as never;

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  auth.permission = 'admin';
  auth.extension = false;
  process.env.INTEGRATIONS_SECRET_KEY = 'unit-test-integrations-key-please-change-32+chars';
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  for (const id of ['kontakt', 'other']) {
    await s.setDoc(`${paths.forms(ORG, SITE)}/${id}`, {
      name: id,
      steps: [{ id: 'main', blocks: [{ id: 'f-email', type: 'form/email', data: { name: 'email', label: 'E', required: true } }] }],
      actions: id === 'kontakt' ? [{ id: 'a1', type: 'email', config: { to: 'owner@site.com', subject: 's', body: 'b' } }] : [],
      created_at: new Date().toISOString(),
    });
  }
  await s.setDoc(`${paths.submissions(ORG, SITE)}/sub-1`, { form_id: 'kontakt', data: { email: 'a@b.com' }, created_at: '2026-01-01T00:00:00.000Z' });
  await s.setDoc(`${paths.submissions(ORG, SITE)}/sub-2`, { form_id: 'kontakt', data: { email: 'c@d.com' }, created_at: '2026-01-02T00:00:00.000Z' });
  await s.setDoc(`${paths.submissions(ORG, SITE)}/sub-3`, { form_id: 'other', data: {}, created_at: '2026-01-03T00:00:00.000Z' });
  await s.setDoc(`${paths.formWebhookDeliveries(ORG, SITE)}/d-1`, {
    event_id: 'e', form_id: 'kontakt', submission_id: 'sub-1', webhook_id: 'w1', url: 'https://8.8.8.8/hook',
    status: 'failed', attempts: 3, response_status: 500, last_error: 'HTTP 500', created_at: 'x', updated_at: 'y',
  });
});

function req(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost/api/v1/sites/${SITE}/${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function submission(method: 'GET' | 'DELETE', formId: string, submissionId: string): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions/[submissionId]');
  return (mod as Record<string, (ctx: unknown) => Promise<Response>>)[method]!({
    request: req(`forms/${formId}/submissions/${submissionId}`, method), params: { siteId: SITE, formId, submissionId },
  });
}

async function list(formId: string): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions');
  return mod.GET({ request: req(`forms/${formId}/submissions`), params: { siteId: SITE, formId } } as never);
}

describe('v1 form capabilities', () => {
  async function capabilities(): Promise<Response> {
    const mod = await import('../../pages/api/v1/sites/[siteId]/form-capabilities');
    return mod.GET({ request: req('form-capabilities'), params: { siteId: SITE } } as never);
  }

  it('lists the action types and prefill sources the portal editor offers', async () => {
    const res = await capabilities();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions.map((a: { type: string }) => a.type)).toEqual(expect.arrayContaining(['email', 'webhook']));
    expect(body.actions.find((a: { type: string }) => a.type === 'email')).toMatchObject({ admin_only: true, config_fields: expect.any(Array) });
    expect(Array.isArray(body.prefill_sources)).toBe(true);

    const portal = await import('../../pages/api/sites/[siteId]/form-capabilities');
    const portalBody = await (await portal.GET({ cookies, params: { siteId: SITE }, locals } as never)).json();
    expect(portalBody).toEqual(body);
  });

  it('requires admin permission, like the portal', async () => {
    auth.permission = 'write';
    expect((await capabilities()).status).toBe(403);
  });
});

describe('v1 form submissions', () => {
  it('reads one submission, with webhook delivery status for admins', async () => {
    const res = await submission('GET', 'kontakt', 'sub-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submission).toMatchObject({ id: 'sub-1', form_id: 'kontakt', data: { email: 'a@b.com' } });
    expect(body.submission.webhook_deliveries).toEqual([
      { webhook_id: 'w1', status: 'failed', attempts: 3, response_status: 500, last_error: 'HTTP 500', updated_at: 'y' },
    ]);
    expect(JSON.stringify(body)).not.toContain('8.8.8.8');

    auth.permission = 'read';
    const reader = await (await submission('GET', 'kontakt', 'sub-1')).json();
    expect(reader.submission.data).toEqual({ email: 'a@b.com' });
    expect(reader.submission.webhook_deliveries).toBeUndefined();
  });

  it('does not read a submission through another form, or of an unknown form', async () => {
    expect((await submission('GET', 'kontakt', 'sub-3')).status).toBe(404);
    expect((await submission('GET', 'missing', 'sub-1')).status).toBe(404);
    expect((await submission('GET', 'kontakt', 'nope')).status).toBe(404);
  });

  it('lists with delivery status for admins only', async () => {
    const admin = await (await list('kontakt')).json();
    expect(admin.submissions.map((s: { id: string }) => s.id)).toEqual(['sub-2', 'sub-1']);
    expect(admin.submissions[1].webhook_deliveries).toHaveLength(1);
    auth.permission = 'write';
    const writer = await (await list('kontakt')).json();
    expect(writer.submissions[1].webhook_deliveries).toBeUndefined();
  });

  it('deletes one submission with its webhook delivery records', async () => {
    const res = await submission('DELETE', 'kontakt', 'sub-1');
    expect(await res.json()).toEqual({ ok: true, deleted_submission_id: 'sub-1', form_id: 'kontakt' });
    const s = await store();
    expect(await s.getDoc(`${paths.submissions(ORG, SITE)}/sub-1`)).toBeNull();
    expect(await s.getDoc(`${paths.formWebhookDeliveries(ORG, SITE)}/d-1`)).toBeNull();
    expect((await submission('DELETE', 'other', 'sub-2')).status).toBe(404);
  });

  it('deletes a form with its submissions and their delivery records', async () => {
    const mod = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]');
    const res = await mod.DELETE({ request: req('forms/kontakt?delete_submissions=true', 'DELETE'), params: { siteId: SITE, formId: 'kontakt' } } as never);
    expect(res.status).toBe(200);
    const s = await store();
    expect(await s.getDoc(`${paths.submissions(ORG, SITE)}/sub-2`)).toBeNull();
    expect(await s.getDoc(`${paths.formWebhookDeliveries(ORG, SITE)}/d-1`)).toBeNull();
    expect(await s.getDoc(`${paths.submissions(ORG, SITE)}/sub-3`)).not.toBeNull();
  });

  it('counts submissions per form in the forms list, as the portal does', async () => {
    const mod = await import('../../pages/api/v1/sites/[siteId]/forms/index');
    const body = await (await mod.GET({ request: req('forms'), params: { siteId: SITE } } as never)).json();
    const counts = Object.fromEntries(body.forms.map((f: { id: string; submission_count: number }) => [f.id, f.submission_count]));
    expect(counts).toEqual({ kontakt: 2, other: 1 });
  });

  it('matches the portal route for one submission', async () => {
    const portal = await import('../../pages/api/sites/[siteId]/forms/[formId]/submissions/[submissionId]');
    const portalBody = await (await portal.GET({ cookies, params: { siteId: SITE, formId: 'kontakt', submissionId: 'sub-1' }, locals } as never)).json();
    const apiBody = await (await submission('GET', 'kontakt', 'sub-1')).json();
    expect(apiBody.submission).toEqual(portalBody.submission);
  });
});

describe('form actions and app installation credentials', () => {
  it('never shows or accepts actions for an installation credential', async () => {
    auth.extension = true;
    const mod = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]');
    const read = await (await mod.GET({ request: req('forms/kontakt'), params: { siteId: SITE, formId: 'kontakt' } } as never)).json();
    expect(read.form.actions).toEqual([]);
    const write = await mod.PATCH({
      request: req('forms/kontakt', 'PATCH', { actions: [{ type: 'email', config: { to: 'x@evil.example', subject: 's', body: 'b' } }] }),
      params: { siteId: SITE, formId: 'kontakt' },
    } as never);
    expect(write.status).toBe(403);
    const form = await (await store()).getDoc<Form>(`${paths.forms(ORG, SITE)}/kontakt`);
    expect((form!.actions[0]!.config as { to: string }).to).toBe('owner@site.com');

    const index = await import('../../pages/api/v1/sites/[siteId]/forms/index');
    const listed = await (await index.GET({ request: req('forms'), params: { siteId: SITE } } as never)).json();
    expect(listed.forms.every((f: { actions: unknown[]; submission_count?: number }) => f.actions.length === 0 && f.submission_count === undefined)).toBe(true);
  });
});
