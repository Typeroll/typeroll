// Preview forms never reach storage or actions: the submit endpoint refuses
// any request carrying the preview marker, even with a valid token, for the
// runtime protocol, a no-JS post and the JSON API alike.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, FORM_PREVIEW_FIELD } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

let ipCounter = 0;
const nextIp = () => `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'd'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, {
    name: 'Contact',
    actions: [{ type: 'email', to: 'owner@example.test' }],
    created_at: new Date().toISOString(),
    steps: [{ id: 'main', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email' } }] }],
  } as unknown as Omit<Form, 'id'>);
  const { signFormToken } = await import('../../lib/forms-signing');
  return { token: signFormToken(ORG, SITE, 'contact') };
}

async function submit(body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('../../pages/api/forms/submit');
  return POST({ request: new Request('http://localhost/api/forms/submit', { method: 'POST', headers: { 'x-forwarded-for': nextIp(), ...headers }, body }) } as never) as Promise<Response>;
}

async function stored() {
  const { getStore } = await import('../../lib/datastore');
  return getStore().listDocs(paths.submissions(ORG, SITE));
}

describe('submit endpoint preview guard', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('refuses the runtime protocol with the preview marker even with a valid token', async () => {
    const { token } = await setup();
    const actions = await import('../../lib/forms/actions');
    const run = vi.spyOn(actions, 'runFormActions');
    const fd = new FormData();
    fd.set('_token', token); fd.set('_protocol', '1'); fd.set(FORM_PREVIEW_FIELD, '1'); fd.set('email', 'ada@example.test');
    const res = await submit(fd, { accept: 'application/json' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, preview: true, errors: [{ code: 'preview' }] });
    expect(await stored()).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('answers a no-JS preview post with an HTML page and stores nothing', async () => {
    await setup();
    const res = await submit(new URLSearchParams([['_token', ''], [FORM_PREVIEW_FIELD, '1'], ['email', 'ada@example.test']]));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('This is a preview – nothing was sent.');
    expect(await stored()).toHaveLength(0);
  });

  it('refuses the marker in JSON data', async () => {
    const { token } = await setup();
    const res = await submit(JSON.stringify({ token, data: { email: 'ada@example.test', [FORM_PREVIEW_FIELD]: '' } }), { 'content-type': 'application/json' });
    expect(res.status).toBe(403);
    expect(await stored()).toHaveLength(0);
  });

  it('still accepts the same submission without the marker', async () => {
    const { token } = await setup();
    const res = await submit(JSON.stringify({ token, data: { email: 'ada@example.test' } }), { 'content-type': 'application/json' });
    expect(res.status).toBe(200);
    expect(await stored()).toHaveLength(1);
  });
});
