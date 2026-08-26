// Steps-only storage: a flat `fields` list on the form write APIs is
// authoring sugar the server converts to ONE static step (fieldsToSteps).
// These tests pin the conversion at the v1 route level and prove the
// converted form works end-to-end through the (only) submit pipeline.

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

async function createForm(token: string, body: Record<string, unknown>): Promise<Response> {
  const mod = await import('../../pages/api/v1/sites/[siteId]/forms/index') as { POST: APIRoute };
  const req = new Request(`https://portal.example.com/api/v1/sites/${SITE}/forms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return mod.POST({ request: req, params: { siteId: SITE } } as never) as Promise<Response>;
}

describe('v1 form create — fields is sugar for a single-step form', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('converts fields[] to one static step; nothing else is stored', async () => {
    const { token } = await setup();
    const res = await createForm(token, {
      id: 'kontakt',
      name: 'Kontakt',
      fields: [
        { name: 'email', type: 'email', label: 'E-post', required: true },
        { name: 'gdpr', type: 'gdpr_consent', label: 'Jag godkänner' },
      ],
      success_message: 'Tack!',
    });
    expect(res.status).toBe(201);
    const out = await res.json() as { form: Record<string, unknown> };
    const steps = out.form.steps as Array<{ id: string; blocks: Array<{ type: string }> }>;
    expect(steps).toHaveLength(1);
    expect(steps[0].blocks.map((b) => b.type)).toEqual(['form/email', 'form/consent']);
    expect(out.form.fields).toBeUndefined();
  });

  it('explicit steps win when both are provided; steps-only creates work', async () => {
    const { token } = await setup();
    const res = await createForm(token, {
      id: 'funnel',
      name: 'Funnel',
      fields: [{ name: 'ignored', type: 'text', label: 'X' }],
      steps: [
        { id: 'one', blocks: [{ id: 'b1', type: 'form/text', data: { name: 'x', label: 'X' } }] },
        { id: 'two', blocks: [{ id: 'b2', type: 'form/email', data: { name: 'e', label: 'E' } }] },
      ],
    });
    expect(res.status).toBe(201);
    const out = await res.json() as { form: { steps: Array<{ id: string }> } };
    expect(out.form.steps.map((s) => s.id)).toEqual(['one', 'two']);
  });

  it('rejects a create with neither fields nor steps', async () => {
    const { token } = await setup();
    const res = await createForm(token, { id: 'empty', name: 'Empty' });
    expect(res.status).toBe(400);
  });

  it('a fields-created form works end-to-end through the submit pipeline', async () => {
    const { token } = await setup();
    await createForm(token, {
      id: 'kontakt',
      name: 'Kontakt',
      fields: [{ name: 'email', type: 'email', label: 'E-post', required: true }],
      success_message: 'Tack!',
    });
    const { signFormToken } = await import('../../lib/forms-signing');
    const submitToken = await signFormToken(ORG, SITE, 'kontakt');
    const mod = await import('../../pages/api/forms/submit');

    // Missing required field → protocol error with the field name.
    const bad = await mod.POST({
      request: new Request('https://portal.example.com/api/forms/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _token: submitToken, _hp: '', _protocol: '1' }).toString(),
      }),
      clientAddress: '203.0.113.7',
    } as never) as Response;
    expect(bad.status).toBe(400);
    const badOut = await bad.json();
    expect(badOut.ok).toBe(false);
    expect(badOut.errors).toEqual([
      expect.objectContaining({ field: 'email', code: 'required' }),
    ]);

    // Valid submit → done + stored.
    const good = await mod.POST({
      request: new Request('https://portal.example.com/api/forms/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _token: submitToken, _hp: '', _protocol: '1', email: 'a@b.se' }).toString(),
      }),
      clientAddress: '203.0.113.7',
    } as never) as Response;
    expect(good.status).toBe(200);
    const goodOut = await good.json();
    expect(goodOut).toMatchObject({ ok: true, done: true });
    const { getStore } = await import('../../lib/datastore');
    const subs = await getStore().listDocs<{ data: Record<string, unknown> }>(paths.submissions(ORG, SITE));
    expect(subs).toHaveLength(1);
    expect(subs[0].data.email).toBe('a@b.se');
  });

  it('a stored form without steps answers 422, never a crash', async () => {
    const { getStore } = await import('../../lib/datastore');
    await setup();
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/broken`, {
      name: 'Broken', actions: [], created_at: new Date().toISOString(),
    });
    const { signFormToken } = await import('../../lib/forms-signing');
    const submitToken = await signFormToken(ORG, SITE, 'broken');
    const mod = await import('../../pages/api/forms/submit');
    const res = await mod.POST({
      request: new Request('https://portal.example.com/api/forms/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: submitToken, data: { _hp: '' } }),
      }),
      clientAddress: '203.0.113.7',
    } as never) as Response;
    expect(res.status).toBe(422);
  });
});
