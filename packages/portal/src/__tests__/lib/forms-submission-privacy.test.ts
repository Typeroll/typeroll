// Form submission privacy: no IP address or user agent is stored, legacy
// values never reach read-level callers, and the opt-in per-site retention
// period stamps, hides and deletes completed submissions without touching
// anything while it is unset.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { Form, Site } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

process.env.AUTH_TRUST_PROXY_HOPS = '1';

const ORG = 'default';
const SITE = 'mysite';
const DAY = 86_400_000;
const auth = vi.hoisted(() => ({ permission: 'admin' as string, extension: false, site: {} as Record<string, unknown> }));

vi.mock('../../lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-auth')>();
  return {
    ...actual,
    requireApiKey: async (request: Request, siteId: string) => ({
      ok: true,
      value: {
        orgId: ORG, tokenOrgId: ORG, tokenSiteId: siteId, siteId, versionId: 'main',
        site: { id: siteId, name: 'My Site', ...auth.site }, keyPrefix: 'test', permission: auth.permission,
        request, path: new URL(request.url).pathname,
        ...(auth.extension ? { extensionIdentity: { installationId: 'app-one', scopes: ['content:write', 'submissions:read'] } } : {}),
      },
    }),
  };
});

vi.mock('../../lib/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/access')>();
  return {
    ...actual,
    requireSiteAccess: async (...args: Parameters<typeof actual.requireSiteAccess>) => {
      const result = await actual.requireSiteAccess(...args);
      return result.ok ? { ok: true, value: { ...result.value, permission: auth.permission } } : result;
    },
  };
});

const FORM: Omit<Form, 'id'> = {
  name: 'Lead',
  actions: [],
  created_at: new Date().toISOString(),
  steps: [{ id: 'one', blocks: [{ id: 'n', type: 'form/text', data: { name: 'name', label: 'Name', required: true } }] }],
};

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

const subPath = (id: string) => `${paths.submissions(ORG, SITE)}/${id}`;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  auth.permission = 'admin';
  auth.extension = false;
  auth.site = {};
  process.env.FORMS_HMAC_SECRET = 'h'.repeat(48);
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await s.setDoc(`${paths.forms(ORG, SITE)}/lead`, FORM);
});

let ipCounter = 0;
async function submit(data: Record<string, unknown>): Promise<Response> {
  const { signFormToken } = await import('../../lib/forms-signing');
  const { POST } = await import('../../pages/api/forms/submit');
  const token = signFormToken(ORG, SITE, 'lead');
  return POST({
    request: new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${++ipCounter}`, 'user-agent': 'Mozilla/5.0 Test' },
      body: JSON.stringify({ token, data }),
    }),
  } as never) as Promise<Response>;
}

async function stored(): Promise<Array<Record<string, unknown>>> {
  return (await store()).listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
}

describe('submission storage', () => {
  it('stores neither the IP address nor the user agent', async () => {
    expect((await submit({ name: 'Ada' })).status).toBe(200);
    const [saved] = await stored();
    expect(saved).toBeDefined();
    expect(saved).not.toHaveProperty('submitted_from_ip');
    expect(saved).not.toHaveProperty('user_agent');
    expect(JSON.stringify(saved)).not.toContain('10.9.0.');
  });

  it('keeps completed submissions without an expiry while retention is unset', async () => {
    await submit({ name: 'Ada' });
    const [saved] = await stored();
    expect(saved!.expires_at).toBeNull();
    expect(saved).not.toHaveProperty('delete_at');
  });

  it('stamps expires_at and a TTL timestamp from the site retention period', async () => {
    await (await store()).updateDoc(paths.site(ORG, SITE), { form_submission_retention_days: 90 });
    const before = Date.now();
    await submit({ name: 'Ada' });
    const [saved] = await stored();
    const expires = Date.parse(String(saved!.expires_at));
    expect(expires).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(expires).toBeLessThanOrEqual(Date.now() + 90 * DAY);
    // The fixtures store serializes the native Date the TTL policy reads.
    expect(Date.parse(String(saved!.delete_at))).toBe(expires);
  });
});

describe('submission views', () => {
  beforeEach(async () => {
    await (await store()).setDoc(subPath('legacy'), {
      form_id: 'lead', data: { name: 'Old' }, created_at: ago(400), status: 'complete',
      submitted_from_ip: '203.0.113.5', user_agent: `UA-${'x'.repeat(400)}`, delete_at: new Date(),
    });
  });

  it('never returns the legacy IP address and shows the user agent to admins only, truncated', async () => {
    const { listFormSubmissions, readFormSubmission } = await import('../../lib/form-submissions');
    const admin = (await listFormSubmissions(ORG, SITE, 'lead', { isAdmin: true })).submissions[0]!;
    expect(admin).not.toHaveProperty('submitted_from_ip');
    expect(admin).not.toHaveProperty('delete_at');
    expect(admin.user_agent).toHaveLength(256);
    const reader = (await listFormSubmissions(ORG, SITE, 'lead', { isAdmin: false })).submissions[0]!;
    expect(reader).not.toHaveProperty('submitted_from_ip');
    expect(reader).not.toHaveProperty('user_agent');
    const one = await readFormSubmission(ORG, SITE, 'lead', 'legacy', false);
    expect(one).not.toHaveProperty('submitted_from_ip');
    expect(one).not.toHaveProperty('user_agent');
    expect(one!.data).toEqual({ name: 'Old' });
  });

  it('strips them on the v1 API for read keys and Extension credentials', async () => {
    const mod = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]/submissions/[submissionId]');
    for (const [permission, extension] of [['read', false], ['admin', true]] as const) {
      auth.permission = permission;
      auth.extension = extension;
      const res = await mod.GET({
        request: new Request(`http://localhost/api/v1/sites/${SITE}/forms/lead/submissions/legacy`),
        params: { siteId: SITE, formId: 'lead', submissionId: 'legacy' },
      } as never);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).not.toContain('203.0.113.5');
      expect(body).not.toContain('user_agent');
    }
  });
});

describe('opt-in retention', () => {
  let partialExpiry = '';
  beforeEach(async () => {
    const s = await store();
    partialExpiry = ago(70);
    await s.setDoc(subPath('old'), { form_id: 'lead', data: {}, status: 'complete', created_at: ago(100), updated_at: ago(100), expires_at: null });
    await s.setDoc(subPath('legacy-old'), { form_id: 'lead', data: {}, created_at: ago(200) });
    await s.setDoc(subPath('recent'), { form_id: 'lead', data: {}, status: 'complete', created_at: ago(5), updated_at: ago(5), expires_at: null });
    await s.setDoc(subPath('partial'), { form_id: 'lead', data: {}, status: 'partial', created_at: ago(100), updated_at: ago(100), expires_at: partialExpiry });
    await s.setDoc(subPath('intake'), { form_id: 'lead', data: {}, status: 'complete', created_at: ago(100), intake: {}, expires_at: null });
    await s.setDoc(`${paths.formWebhookDeliveries(ORG, SITE)}/d-old`, { submission_id: 'old', webhook_id: 'w', status: 'delivered', attempts: 1 });
  });

  it('changes nothing while unset: old submissions stay listed and stored', async () => {
    const { listFormSubmissions } = await import('../../lib/form-submissions');
    const ids = (await listFormSubmissions(ORG, SITE, 'lead', { isAdmin: true })).submissions.map((s) => s.id).sort();
    expect(ids).toEqual(['intake', 'legacy-old', 'old', 'partial', 'recent']);
    expect((await stored()).map((s) => s.id).sort()).toEqual(['intake', 'legacy-old', 'old', 'partial', 'recent']);
  });

  it('hides and deletes expired completed submissions on read, from the current setting', async () => {
    const s = await store();
    await s.updateDoc(paths.site(ORG, SITE), { form_submission_retention_days: 30 });
    const { listFormSubmissions, readFormSubmission } = await import('../../lib/form-submissions');
    expect(await readFormSubmission(ORG, SITE, 'lead', 'old', true)).toBeNull();
    expect(await s.getDoc(subPath('old'))).toBeNull();
    const ids = (await listFormSubmissions(ORG, SITE, 'lead', { isAdmin: true })).submissions.map((x) => x.id).sort();
    expect(ids).toEqual(['intake', 'partial', 'recent']);
    expect((await stored()).map((x) => x.id).sort()).toEqual(['intake', 'partial', 'recent']);
    expect(await s.getDoc(`${paths.formWebhookDeliveries(ORG, SITE)}/d-old`)).toBeNull();
  });

  it('applies a new period to existing submissions and clears it again', async () => {
    const { setSubmissionRetention } = await import('../../lib/form-submissions');
    const s = await store();
    const set = await setSubmissionRetention(ORG, SITE, 30);
    expect(set).toEqual({ form_submission_retention_days: 30, updated: 1, deleted: 2 });
    expect((await s.getDoc<Site>(paths.site(ORG, SITE)))!.form_submission_retention_days).toBe(30);
    expect((await stored()).map((x) => x.id).sort()).toEqual(['intake', 'partial', 'recent']);
    const recent = await s.getDoc<Record<string, unknown>>(subPath('recent'));
    expect(Date.parse(String(recent!.expires_at))).toBe(Date.parse(String(recent!.updated_at)) + 30 * DAY);
    expect(recent!.delete_at).toBeTruthy();
    // Partials and app intake records keep their own expiry.
    const partial = await s.getDoc<Record<string, unknown>>(subPath('partial'));
    expect(partial!.expires_at).toBe(partialExpiry);
    expect(partial).not.toHaveProperty('delete_at');
    expect(await s.getDoc<Record<string, unknown>>(subPath('intake'))).not.toHaveProperty('delete_at');
    // Idempotent: nothing left to change.
    expect(await setSubmissionRetention(ORG, SITE, 30)).toEqual({ form_submission_retention_days: 30, updated: 0, deleted: 0 });

    expect(await setSubmissionRetention(ORG, SITE, null)).toEqual({ form_submission_retention_days: null, updated: 1, deleted: 0 });
    const kept = await s.getDoc<Record<string, unknown>>(subPath('recent'));
    expect(kept!.expires_at).toBeNull();
    expect(kept!.delete_at).toBeNull();
  });
});

describe('retention setting in the v1 settings API', () => {
  async function patch(body: unknown): Promise<Response> {
    const mod = await import('../../pages/api/v1/sites/[siteId]/settings');
    return mod.PATCH({
      request: new Request(`http://localhost/api/v1/sites/${SITE}/settings`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      params: { siteId: SITE },
    } as never);
  }

  it('lets an admin set it and reports what was applied', async () => {
    await (await store()).setDoc(subPath('old'), { form_id: 'lead', data: {}, status: 'complete', created_at: ago(100) });
    const res = await patch({ form_submission_retention_days: 60 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated_fields).toEqual(['form_submission_retention_days']);
    expect(body.form_submission_retention).toEqual({ form_submission_retention_days: 60, updated: 0, deleted: 1 });
    expect((await (await store()).getDoc<Site>(paths.site(ORG, SITE)))!.form_submission_retention_days).toBe(60);
  });

  it('returns it from GET as a site-wide setting', async () => {
    const mod = await import('../../pages/api/v1/sites/[siteId]/settings');
    auth.site = { form_submission_retention_days: 365 };
    const res = await mod.GET({ request: new Request(`http://localhost/api/v1/sites/${SITE}/settings`), params: { siteId: SITE } } as never);
    expect((await res.json()).settings.form_submission_retention_days).toBe(365);
    auth.site = {};
    const unset = await mod.GET({ request: new Request(`http://localhost/api/v1/sites/${SITE}/settings`), params: { siteId: SITE } } as never);
    expect((await unset.json()).settings.form_submission_retention_days).toBeNull();
  });

  it('refuses values outside 30–3650 days', async () => {
    for (const value of [0, 29, 3651, 45.5, '90', true]) {
      expect((await patch({ form_submission_retention_days: value })).status).toBe(400);
    }
    expect((await (await store()).getDoc<Site>(paths.site(ORG, SITE)))!.form_submission_retention_days).toBeUndefined();
  });

  it('is admin-only: write keys and Extension credentials are refused', async () => {
    await (await store()).setDoc(subPath('old'), { form_id: 'lead', data: {}, status: 'complete', created_at: ago(100) });
    auth.permission = 'write';
    expect((await patch({ form_submission_retention_days: 30 })).status).toBe(403);
    auth.permission = 'admin';
    auth.extension = true;
    const refused = await patch({ form_submission_retention_days: 30 });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain('form_submission_retention_days');
    expect(await (await store()).getDoc(subPath('old'))).not.toBeNull();
  });
});

describe('retention setting in the portal', () => {
  async function post(body: unknown): Promise<Response> {
    const mod = await import('../../pages/api/sites/[siteId]/form-submission-retention');
    return mod.POST({
      request: new Request(`http://localhost/api/sites/${SITE}/form-submission-retention`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      cookies: { get: () => undefined }, params: { siteId: SITE }, locals: {},
    } as never);
  }

  it('lets a site admin set and clear it, and refuses editors and invalid values', async () => {
    auth.permission = 'write';
    expect((await post({ days: 30 })).status).toBe(403);
    auth.permission = 'admin';
    expect((await post({ days: 10 })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(await (await post({ days: 30 })).json()).toMatchObject({ ok: true, form_submission_retention_days: 30 });
    expect((await (await store()).getDoc<Site>(paths.site(ORG, SITE)))!.form_submission_retention_days).toBe(30);
    expect(await (await post({ days: null })).json()).toMatchObject({ ok: true, form_submission_retention_days: null });
    expect((await (await store()).getDoc<Site>(paths.site(ORG, SITE)))!.form_submission_retention_days).toBeNull();
  });
});
