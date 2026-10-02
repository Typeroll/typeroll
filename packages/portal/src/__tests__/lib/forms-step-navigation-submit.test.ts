// Back navigation against the real submit endpoint. Going back sends
// nothing; sending an earlier step again (named with `_step`) updates the
// same partial submission and never starts a new one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

const FORM: Omit<Form, 'id'> = {
  name: 'Lead',
  actions: [],
  created_at: new Date().toISOString(),
  steps: [
    { id: 'contact', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } }] },
    { id: 'company', blocks: [{ id: 'c', type: 'form/text', data: { name: 'company', label: 'Company', required: true } }] },
    { id: 'quote', render: 'dynamic', title: 'Quote', submit_label: 'Accept quote', blocks: [
      { id: 'h', type: 'form/heading', data: { text: 'Your quote' } },
      { id: 'a', type: 'form/text', data: { name: 'accept', label: 'Accept' } },
    ] },
    { id: 'message', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Message' } }] },
  ],
};

let ipCounter = 0;
const nextIp = () => `10.6.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
let clock = Date.now();

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'e'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/lead`, FORM);
  const { signFormToken } = await import('../../lib/forms-signing');
  return signFormToken(ORG, SITE, 'lead');
}

async function post(token: string, fields: Record<string, string>) {
  // Each step is sent "later" than the server's minimum step interval.
  clock += 5_000;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  const { POST } = await import('../../pages/api/forms/submit');
  const body = new FormData();
  body.set('_token', token); body.set('_protocol', '1');
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const res = await POST({ request: new Request('http://localhost/api/forms/submit', { method: 'POST', headers: { 'x-forwarded-for': nextIp(), accept: 'application/json' }, body }) } as never) as Response;
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function submissions() {
  const { getStore } = await import('../../lib/datastore');
  return getStore().listDocs<Record<string, any>>(paths.submissions(ORG, SITE));
}

describe('back navigation on the submit endpoint', () => {
  beforeEach(async () => { await resetDatastore(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('updates the same partial submission when an earlier step is sent again', async () => {
    const token = await setup();
    const one = await post(token, { _step: 'contact', email: 'ada@example.test' });
    expect(one.body).toMatchObject({ ok: true, next_step: 'company' });
    const two = await post(token, { _step: 'company', _state: one.body.state, company: 'Acme' });
    expect(two.body).toMatchObject({ ok: true, step: 'quote' });
    const [stored] = await submissions();
    expect(stored).toMatchObject({ status: 'partial', step: 'company', data: { email: 'ada@example.test', company: 'Acme' } });

    // Back twice in the browser sends nothing; the stored partial is as it was.
    expect(await submissions()).toEqual([stored]);

    // Step 1 again, with the latest continuation: same document, new email,
    // later answers kept, and the visitor continues from step 2.
    const again = await post(token, { _step: 'contact', _state: two.body.state, email: 'ada@acme.test' });
    expect(again.body).toMatchObject({ ok: true, next_step: 'company' });
    const after = await submissions();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: stored.id, status: 'partial', step: 'contact', data: { email: 'ada@acme.test', company: 'Acme' } });

    const forward = await post(token, { _step: 'company', _state: again.body.state, company: 'Acme AB' });
    expect(forward.body.step).toBe('quote');
    const quote = await post(token, { _step: 'quote', _state: forward.body.state, accept: 'yes' });
    expect(quote.body.next_step).toBe('message');
    const done = await post(token, { _step: 'message', _state: quote.body.state, message: 'Hi' });
    expect(done.body).toMatchObject({ ok: true, done: true });
    const final = await submissions();
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ status: 'complete', data: { email: 'ada@acme.test', company: 'Acme AB', accept: 'yes', message: 'Hi' } });
  });

  it('refuses a step the visitor has not reached and a stale continuation', async () => {
    const token = await setup();
    expect((await post(token, { _step: 'company', company: 'Acme' })).status).toBe(409);
    const one = await post(token, { _step: 'contact', email: 'ada@example.test' });
    expect((await post(token, { _step: 'message', _state: one.body.state, message: 'skip' })).status).toBe(409);
    const two = await post(token, { _step: 'company', _state: one.body.state, company: 'Acme' });
    expect(two.status).toBe(200);
    // The continuation from step 1 is spent once step 2 is stored.
    expect((await post(token, { _step: 'contact', _state: one.body.state, email: 'x@example.test' })).status).toBe(409);
    expect(await submissions()).toHaveLength(1);
  });

  it('labels dynamic steps and drops a duplicate title from render version 5', async () => {
    const token = await setup();
    const one = await post(token, { email: 'ada@example.test' });
    const v5 = await post(token, { _state: one.body.state, company: 'Acme', _rv: '5' });
    expect(v5.body).toMatchObject({ step: 'quote', submit_label: 'Accept quote', final: false });
    expect(v5.body.html).not.toContain('form-step-title');
    expect(v5.body.html).toContain('Your quote');

    const token2 = token;
    const first = await post(token2, { email: 'bo@example.test' });
    const legacy = await post(token2, { _state: first.body.state, company: 'Bolaget' });
    expect(legacy.body.html).toContain('<h3 class="form-step-title">Quote</h3>');
  });
});
