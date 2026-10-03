// Opt-in follow-up on abandoned partial submissions: an email action with
// trigger "partial_abandoned" runs once per submission that has not advanced
// for after_hours, through the scheduled-work index. Never for completed
// submissions; completion actions never run it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form, FormAction } from '@typeroll/shared';
import { validateEmailActions } from '../../lib/forms-admin';

const ORG = 'orgone';
const SITE = 'mysite';
const HOUR = 3_600_000;

const ABANDONED: FormAction = { id: 'nudge', type: 'email', trigger: 'partial_abandoned', after_hours: 2, config: { to: 'owner@example.test', subject: 'Unfinished lead: {{email}}', body: '<p>{{email}} stopped.</p>', include_all: true } };
const LATER: FormAction = { id: 'later', type: 'email', trigger: 'partial_abandoned', after_hours: 24, config: { to: 'owner@example.test', subject: 'Still unfinished', body: '<p>x</p>' } };
const ON_COMPLETE: FormAction = { id: 'done', type: 'email', config: { to: 'owner@example.test', subject: 'New lead', body: '<p>x</p>' } };

const FORM: Omit<Form, 'id'> = {
  name: 'Lead',
  actions: [ABANDONED, LATER, ON_COMPLETE],
  created_at: new Date().toISOString(),
  steps: [
    { id: 'contact', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } }] },
    { id: 'company', blocks: [{ id: 'c', type: 'form/text', data: { name: 'company', label: 'Company' } }] },
    { id: 'message', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Message' } }] },
  ],
};

let ipCounter = 0;
const nextIp = () => `10.5.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
let clock = Date.UTC(2026, 9, 1, 8);
const setClock = (value: number) => { clock = value; };

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'g'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/lead`, FORM);
  const { signFormToken } = await import('../../lib/forms-signing');
  const { actionRegistry } = await import('../../lib/forms/actions');
  const email = (await actionRegistry()).get('email')!;
  const sent = vi.spyOn(email, 'run').mockResolvedValue(undefined);
  return { token: signFormToken(ORG, SITE, 'lead'), sent };
}

async function post(token: string, fields: Record<string, string>) {
  vi.useFakeTimers({ now: clock, toFake: ['Date'] });
  try {
    const { POST } = await import('../../pages/api/forms/submit');
    const body = new FormData();
    body.set('_token', token); body.set('_protocol', '1');
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const res = await POST({ request: new Request('http://localhost/api/forms/submit', { method: 'POST', headers: { 'x-forwarded-for': nextIp(), accept: 'application/json' }, body }) } as never) as Response;
    return await res.json() as Record<string, any>;
  } finally {
    vi.useRealTimers();
  }
}

async function scheduled() {
  const { getStore } = await import('../../lib/datastore');
  const { WORK_COLLECTION } = await import('../../lib/scheduling/index');
  return getStore().listDocs<Record<string, any>>(WORK_COLLECTION);
}

async function runDue(at: number) {
  const { runDueScheduledWork } = await import('../../lib/scheduling/worker');
  return runDueScheduledWork(new Date(at));
}

async function submission() {
  const { getStore } = await import('../../lib/datastore');
  return (await getStore().listDocs<Record<string, any>>(paths.submissions(ORG, SITE)))[0]!;
}

describe('abandoned partial submissions', () => {
  beforeEach(async () => { await resetDatastore(); clock = Date.UTC(2026, 9, 1, 8); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('fires once per action after the delay, through the scheduled-work sweep', async () => {
    const { token, sent } = await setup();
    const start = clock;
    await post(token, { email: 'ada@example.test' });
    const [work] = await scheduled();
    expect(work).toMatchObject({ kind: 'form_partial_abandoned', due_at: start + 2 * HOUR, source: expect.stringContaining('/submissions/') });

    await runDue(start + HOUR);
    expect(sent).not.toHaveBeenCalled();

    await runDue(start + 2 * HOUR + 1000);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![0]).toMatchObject({ id: 'nudge' });
    expect(sent.mock.calls[0]![1]).toMatchObject({ orgId: ORG, siteId: SITE, formId: 'lead', data: { email: 'ada@example.test' }, subject: { kind: 'submission' } });
    expect(await submission()).toMatchObject({ status: 'partial', abandoned_actions_fired: ['nudge'] });
    // The 24-hour action is still pending: the entry was moved, not closed.
    expect((await scheduled())[0]!.due_at).toBe(start + 24 * HOUR);

    // Repeated and late deliveries do not send again.
    await runDue(start + 3 * HOUR);
    await runDue(start + 25 * HOUR);
    await runDue(start + 26 * HOUR);
    expect(sent.mock.calls.map((call) => (call[0] as FormAction).id)).toEqual(['nudge', 'later']);
    expect((await submission()).abandoned_actions_fired).toEqual(['nudge', 'later']);
  });

  it('waits again after the visitor advances, and never fires once the form is completed', async () => {
    const { token, sent } = await setup();
    const start = clock;
    const one = await post(token, { email: 'ada@example.test' });
    setClock(start + HOUR);
    const two = await post(token, { _state: one.state, company: 'Acme' });
    expect((await scheduled())[0]!.due_at).toBe(start + 3 * HOUR);

    // The first deadline passed, but the visitor advanced since.
    await runDue(start + 2 * HOUR + 1000);
    expect(sent).not.toHaveBeenCalled();

    setClock(start + 2 * HOUR + 2000);
    const done = await post(token, { _state: two.state, message: 'Hello' });
    expect(done).toMatchObject({ ok: true, done: true });
    // Only the completion action ran.
    expect(sent.mock.calls.map((call) => (call[0] as FormAction).id)).toEqual(['done']);
    await runDue(start + 30 * HOUR);
    expect(sent.mock.calls.map((call) => (call[0] as FormAction).id)).toEqual(['done']);
    expect(await submission()).toMatchObject({ status: 'complete' });
    expect(await submission()).not.toHaveProperty('abandoned_actions_fired');
  });

  it('claims each action before it runs, so concurrent deliveries send once', async () => {
    const { token, sent } = await setup();
    const start = clock;
    await post(token, { email: 'ada@example.test' });
    const { runAbandonedPartial } = await import('../../lib/forms/abandoned');
    const source = (await scheduled())[0]!.source as string;
    await Promise.all([runAbandonedPartial(source, start + 3 * HOUR), runAbandonedPartial(source, start + 3 * HOUR)]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing for forms without abandoned-partial actions', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/lead`, { ...FORM, actions: [ON_COMPLETE] });
    await post(token, { email: 'ada@example.test' });
    expect(await scheduled()).toHaveLength(0);
  });
});

describe('abandoned-partial action validation', () => {
  it('accepts email actions with a delay and gives them an id', () => {
    const out = validateEmailActions([{ type: 'email', trigger: 'partial_abandoned', after_hours: 2, config: { to: 'a@example.test', subject: 's', body: 'b' } }], ['email', 'webhook']);
    expect(out).toEqual([expect.objectContaining({ type: 'email', trigger: 'partial_abandoned', after_hours: 2, id: expect.any(String) })]);
    expect(validateEmailActions([{ ...ABANDONED }], ['email'])).toEqual([expect.objectContaining({ id: 'nudge' })]);
    expect(validateEmailActions([{ ...ON_COMPLETE, trigger: 'complete' }], ['email'])).toEqual([ON_COMPLETE]);
  });

  it('rejects other action types, missing or invalid delays and unknown triggers', () => {
    const config = { to: 'a@example.test', subject: 's', body: 'b' };
    expect(validateEmailActions([{ type: 'email', trigger: 'partial_abandoned', config }], ['email'])).toMatch(/after_hours/);
    for (const after_hours of [0, 1.5, 721, '2']) {
      expect(typeof validateEmailActions([{ type: 'email', trigger: 'partial_abandoned', after_hours, config }], ['email'])).toBe('string');
    }
    expect(validateEmailActions([{ type: 'webhook', trigger: 'partial_abandoned', after_hours: 2, config: {} }], ['email', 'webhook'])).toMatch(/Only email/);
    expect(validateEmailActions([{ type: 'email', trigger: 'sometime', config }], ['email'])).toMatch(/trigger/);
    expect(validateEmailActions([{ type: 'email', after_hours: 2, config }], ['email'])).toMatch(/after_hours applies only/);
  });

  it('keeps abandoned-partial actions out of completion and pre-submit runs', async () => {
    const { completionActions } = await import('../../lib/forms/actions');
    expect(completionActions({ actions: [ABANDONED, ON_COMPLETE] })).toEqual([ON_COMPLETE]);
  });
});
