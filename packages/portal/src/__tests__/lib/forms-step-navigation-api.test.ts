// Step navigation options on every form write surface: per-step button
// labels (submit_label), allow_back and show_progress, and the warning for a
// step whose title repeats its leading form/heading block.
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';
import { applyStepLabels, validateFormNavigation } from '../../lib/forms-admin';

const ORG = 'orgone';
const SITE = 'mysite';

const STEPS: Form['steps'] = [
  { id: 'contact', title: 'Kontakt', blocks: [
    { id: 'h', type: 'form/heading', data: { text: 'Kontakt' } },
    { id: 'e', type: 'form/email', data: { name: 'email', label: 'E-post', required: true } },
  ] },
  { id: 'details', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Meddelande' } }] },
];

async function v1() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'f'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  await getStore().setDoc(paths.version(ORG, SITE, 'main'), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const create = async (body: unknown) => {
    const { POST } = await import('../../pages/api/v1/sites/[siteId]/forms/index');
    const res = await POST({ request: new Request(`http://localhost/api/v1/sites/${SITE}/forms`, { method: 'POST', headers, body: JSON.stringify(body) }), params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {} } as never) as Response;
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const patch = async (body: unknown) => {
    const { PATCH } = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]');
    const res = await PATCH({ request: new Request(`http://localhost/api/v1/sites/${SITE}/forms/lead`, { method: 'PATCH', headers, body: JSON.stringify(body) }), params: { siteId: SITE, formId: 'lead' }, cookies: { get: () => undefined }, locals: {} } as never) as Response;
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const stored = async () => (await getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/lead`))!;
  return { create, patch, stored };
}

describe('step navigation on the v1 forms API', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('stores submit_label, allow_back and show_progress, and warns about a repeated heading', async () => {
    const api = await v1();
    const created = await api.create({ id: 'lead', name: 'Lead', allow_back: false, show_progress: 'bar',
      steps: [{ ...STEPS[0], submit_label: 'Nästa' }, STEPS[1]] });
    expect(created.status).toBe(201);
    expect(created.body.form).toMatchObject({ allow_back: false, show_progress: 'bar', steps: [{ submit_label: 'Nästa' }, { id: 'details' }] });
    expect(created.body.warnings).toEqual([expect.stringContaining('Step "contact" has a title and starts with a form/heading block')]);

    const cleared = await api.patch({ allow_back: null, show_progress: false });
    expect(cleared.status).toBe(200);
    const doc = await api.stored();
    expect(doc).not.toHaveProperty('allow_back');
    expect(doc).not.toHaveProperty('show_progress');

    expect((await api.patch({ show_progress: true })).status).toBe(200);
    expect((await api.stored()).show_progress).toBe(true);
    const fixed = await api.patch({ steps: [{ ...STEPS[0], title: undefined }, STEPS[1]] });
    expect(fixed.body).not.toHaveProperty('warnings');
  });

  it('rejects invalid values', async () => {
    const api = await v1();
    expect((await api.create({ id: 'lead', name: 'Lead', steps: STEPS, allow_back: 'yes' })).status).toBe(400);
    expect((await api.create({ id: 'lead', name: 'Lead', steps: STEPS, show_progress: 'dots' })).status).toBe(400);
    expect((await api.create({ id: 'lead', name: 'Lead', steps: [{ ...STEPS[0], submit_label: 'x'.repeat(81) }] })).status).toBe(400);
    expect((await api.create({ id: 'lead', name: 'Lead', steps: [{ ...STEPS[0], submit_label: 3 }] })).status).toBe(400);
  });
});

describe('portal editor helpers', () => {
  it('sets and clears step labels on existing steps only', () => {
    const labelled = applyStepLabels(STEPS!, { contact: ' Nästa ', details: '' });
    expect(labelled).toEqual([{ ...STEPS![0], submit_label: 'Nästa' }, STEPS![1]]);
    expect(applyStepLabels(labelled as Form['steps'] & object, { contact: '' })).toEqual(STEPS);
    expect(applyStepLabels(STEPS!, { other: 'x' })).toBe('Unknown step "other"');
  });

  it('validates navigation options', () => {
    expect(validateFormNavigation({ allow_back: true, show_progress: 'text' })).toEqual({ allow_back: true, show_progress: 'text' });
    expect(validateFormNavigation({ show_progress: false })).toEqual({ show_progress: null });
    expect(validateFormNavigation({})).toEqual({});
    expect(typeof validateFormNavigation({ allow_back: 1 })).toBe('string');
  });
});

describe('portal session form update', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('saves step labels and navigation options from the Forms editor', async () => {
    // The dev session belongs to the default organization.
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site('default', SITE), { name: 'S', created_at: new Date().toISOString() });
    await getStore().setDoc(`${paths.forms('default', SITE)}/lead`, { name: 'Lead', actions: [], created_at: 'x', steps: STEPS } satisfies Omit<Form, 'id'>);
    const mod = await import('../../pages/api/sites/[siteId]/forms/[formId]/index');
    const put = (body: unknown) => mod.PUT({
      request: new Request(`http://localhost/api/sites/${SITE}/forms/lead`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      cookies: { get: () => undefined }, params: { siteId: SITE, formId: 'lead' }, locals: {},
    } as never) as Promise<Response>;

    expect((await put({ step_labels: { details: 'Skicka in' }, allow_back: true, show_progress: 'text' })).status).toBe(200);
    expect(await getStore().getDoc<Form>(`${paths.forms('default', SITE)}/lead`)).toMatchObject({
      allow_back: true, show_progress: 'text', steps: [{ id: 'contact' }, { id: 'details', submit_label: 'Skicka in' }],
    });
    expect((await put({ step_labels: { details: '' }, allow_back: null, show_progress: false })).status).toBe(200);
    const cleared = (await getStore().getDoc<Form>(`${paths.forms('default', SITE)}/lead`))!;
    expect(cleared).not.toHaveProperty('allow_back');
    expect(cleared).not.toHaveProperty('show_progress');
    expect(cleared.steps![1]).not.toHaveProperty('submit_label');
    expect((await put({ step_labels: { nope: 'x' } })).status).toBe(400);
  });
});
