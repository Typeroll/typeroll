// Partial submissions (multi-step forms the visitor has not finished) expire
// the form's partial_ttl_days after their last step and are then actually
// deleted: each carries `delete_at`, the store's record-level TTL, so the
// site's store object removes it on its own alarm; reads hide and delete
// expired ones, and an expired partial cannot be resumed. Completing a
// submission clears its partial TTL. Abandoned-partial follow-ups still run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { Form, FormAction } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { scheduledDocumentStore, type AlarmStorage } from '../../lib/store/object-scheduler';
import { SqlStore } from '../../lib/store/sql-store';
import { durableObjectTransport } from '../../lib/store/durable-object';

process.env.AUTH_TRUST_PROXY_HOPS = '1';

const ORG = 'orgone';
const SITE = 'mysite';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 1, 8);

const STEPS: Form['steps'] = [
  { id: 'contact', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } }] },
  { id: 'company', blocks: [{ id: 'c', type: 'form/text', data: { name: 'company', label: 'Company' } }] },
  { id: 'message', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Message' } }] },
];
const NUDGE: FormAction = { id: 'nudge', type: 'email', trigger: 'partial_abandoned', after_hours: 48, config: { to: 'owner@example.test', subject: 'Unfinished', body: '<p>x</p>' } };

let ipCounter = 0;
let clock = T0;

async function store() {
  return (await import('../../lib/datastore')).getStore();
}

async function setup(form: Partial<Form> = {}) {
  const s = await store();
  await s.setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date(T0).toISOString() });
  await s.setDoc(`${paths.forms(ORG, SITE)}/lead`, { name: 'Lead', actions: [], created_at: new Date(T0).toISOString(), steps: STEPS, ...form });
  const { signFormToken } = await import('../../lib/forms-signing');
  return signFormToken(ORG, SITE, 'lead');
}

async function post(token: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, any> }> {
  vi.useFakeTimers({ now: clock, toFake: ['Date'] });
  try {
    const { POST } = await import('../../pages/api/forms/submit');
    const body = new FormData();
    body.set('_token', token); body.set('_protocol', '1');
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const res = await POST({ request: new Request('http://localhost/api/forms/submit', {
      method: 'POST', headers: { 'x-forwarded-for': `10.7.0.${(ipCounter++ % 250) + 1}`, accept: 'application/json' }, body,
    }) } as never) as Response;
    return { status: res.status, body: await res.json() as Record<string, any> };
  } finally {
    vi.useRealTimers();
  }
}

async function only(): Promise<Record<string, any>> {
  const all = await (await store()).listDocs<Record<string, any>>(paths.submissions(ORG, SITE));
  expect(all).toHaveLength(1);
  return all[0]!;
}

const ttlOf = (doc: Record<string, any>) => Date.parse(String(doc.delete_at));

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'p'.repeat(48);
  clock = T0;
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('partial submission expiry on submit', () => {
  it('stamps expires_at and the store TTL from partial_ttl_days and moves both with each step', async () => {
    const token = await setup({ partial_ttl_days: 7 });
    const one = await post(token, { email: 'ada@example.test' });
    expect(one.status).toBe(200);
    let saved = await only();
    expect(saved).toMatchObject({ status: 'partial', expires_at: new Date(T0 + 7 * DAY).toISOString() });
    expect(ttlOf(saved)).toBe(T0 + 7 * DAY);

    clock = T0 + 2 * DAY;
    expect((await post(token, { _state: one.body.state, company: 'Acme' })).status).toBe(200);
    saved = await only();
    expect(saved.expires_at).toBe(new Date(T0 + 9 * DAY).toISOString());
    expect(ttlOf(saved)).toBe(T0 + 9 * DAY);
  });

  it('defaults to 30 days and ignores unusable partial_ttl_days values', async () => {
    for (const value of [undefined, 0, -3, Number.NaN, '5' as unknown as number]) {
      makeTmpFixtures();
      await resetDatastore();
      const token = await setup({ partial_ttl_days: value });
      expect((await post(token, { email: 'ada@example.test' })).status).toBe(200);
      expect(ttlOf(await only())).toBe(T0 + 30 * DAY);
    }
    makeTmpFixtures();
    await resetDatastore();
    const token = await setup({ partial_ttl_days: 1e12 });
    expect((await post(token, { email: 'ada@example.test' })).status).toBe(200);
    expect(ttlOf(await only())).toBe(T0 + 3650 * DAY);
  });

  it('clears the partial TTL when the submission is completed and retention is unset', async () => {
    const token = await setup({ partial_ttl_days: 7 });
    const one = await post(token, { email: 'ada@example.test' });
    clock += MINUTE;
    const two = await post(token, { _state: one.body.state, company: 'Acme' });
    clock += MINUTE;
    expect((await post(token, { _state: two.body.state, message: 'Hello' })).body).toMatchObject({ ok: true, done: true });
    const saved = await only();
    expect(saved).toMatchObject({ status: 'complete', expires_at: null, delete_at: null });
  });

  it('replaces the partial TTL with the site retention period on completion', async () => {
    const token = await setup({ partial_ttl_days: 7 });
    await (await store()).updateDoc(paths.site(ORG, SITE), { form_submission_retention_days: 90 });
    const one = await post(token, { email: 'ada@example.test' });
    clock = T0 + MINUTE;
    const two = await post(token, { _state: one.body.state, company: 'Acme' });
    clock = T0 + HOUR;
    expect((await post(token, { _state: two.body.state, message: 'Hello' })).body).toMatchObject({ ok: true, done: true });
    const saved = await only();
    expect(saved.status).toBe('complete');
    expect(ttlOf(saved)).toBe(T0 + HOUR + 90 * DAY);
  });

  it('starts over instead of resuming a partial past its expiry that the store has not removed yet', async () => {
    const token = await setup({ partial_ttl_days: 1 });
    const one = await post(token, { email: 'ada@example.test' });
    clock = T0 + DAY + 1;
    const late = await post(token, { _state: one.body.state, company: 'Acme' });
    expect(late.status).toBe(409);
    expect(late.body.errors[0].code).toBe('bad_state');
    const saved = await only();
    expect(saved.step).toBe('contact');
    expect(ttlOf(saved)).toBe(T0 + DAY);

    // Just before the expiry it still continues.
    makeTmpFixtures();
    await resetDatastore();
    clock = T0;
    const fresh = await setup({ partial_ttl_days: 1 });
    const first = await post(fresh, { email: 'ada@example.test' });
    clock = T0 + DAY - 1;
    expect((await post(fresh, { _state: first.body.state, company: 'Acme' })).status).toBe(200);
  });

  it('keeps a partial until a day after its last abandoned-partial follow-up is due, and the follow-up still runs', async () => {
    const token = await setup({ partial_ttl_days: 1, actions: [NUDGE] });
    const { actionRegistry } = await import('../../lib/forms/actions');
    const sent = vi.spyOn((await actionRegistry()).get('email')!, 'run').mockResolvedValue(undefined);
    await post(token, { email: 'ada@example.test' });
    const saved = await only();
    expect(ttlOf(saved)).toBe(T0 + 48 * HOUR + DAY);
    expect(saved.expires_at).toBe(new Date(T0 + 48 * HOUR + DAY).toISOString());

    const { runDueScheduledWork } = await import('../../lib/scheduling/worker');
    await runDueScheduledWork(new Date(T0 + 48 * HOUR + 1000));
    expect(sent.mock.calls.map((call) => (call[0] as FormAction).id)).toEqual(['nudge']);
  });
});

describe('expired partials on read', () => {
  const sub = (id: string) => `${paths.submissions(ORG, SITE)}/${id}`;
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();

  beforeEach(async () => {
    await setup();
    const s = await store();
    await s.setDoc(sub('expired'), { form_id: 'lead', data: {}, status: 'partial', created_at: at(-40 * DAY), updated_at: at(-40 * DAY), expires_at: at(-10 * DAY) });
    await s.setDoc(sub('legacy'), { form_id: 'lead', data: {}, status: 'partial', created_at: at(-DAY), updated_at: at(-DAY), expires_at: at(29 * DAY) });
    await s.setDoc(sub('done'), { form_id: 'lead', data: {}, status: 'complete', created_at: at(-400 * DAY), expires_at: null });
    await s.setDoc(sub('answered'), { form_id: 'lead', data: { a: 1 }, status: 'partial', created_at: at(-400 * DAY), intake: {}, expires_at: null });
    await s.setDoc(`${paths.formWebhookDeliveries(ORG, SITE)}/d-expired`, { submission_id: 'expired', webhook_id: 'w', status: 'delivered', attempts: 1 });
  });

  it('hides and deletes expired partials, and gives older partials the store TTL', async () => {
    const { listFormSubmissions } = await import('../../lib/form-submissions');
    const s = await store();
    const ids = (await listFormSubmissions(ORG, SITE, 'lead', { isAdmin: true })).submissions.map((x) => x.id).sort();
    expect(ids).toEqual(['answered', 'done', 'legacy']);
    expect(await s.getDoc(sub('expired'))).toBeNull();
    expect(await s.getDoc(`${paths.formWebhookDeliveries(ORG, SITE)}/d-expired`)).toBeNull();
    const legacy = await s.getDoc<Record<string, any>>(sub('legacy'));
    expect(ttlOf(legacy!)).toBe(Date.parse(legacy!.expires_at));
    // Completed submissions and answered questionnaires keep no TTL.
    expect(await s.getDoc(sub('done'))).not.toHaveProperty('delete_at');
    expect(await s.getDoc(sub('answered'))).not.toHaveProperty('delete_at');
    // The stamp is not part of the view.
    expect((await listFormSubmissions(ORG, SITE, 'lead', { isAdmin: true })).submissions.find((x) => x.id === 'legacy')).not.toHaveProperty('delete_at');
  });

  it('does not return an expired partial by id and deletes it', async () => {
    const { readFormSubmission } = await import('../../lib/form-submissions');
    expect(await readFormSubmission(ORG, SITE, 'lead', 'expired', true)).toBeNull();
    expect(await (await store()).getDoc(sub('expired'))).toBeNull();
    expect(await readFormSubmission(ORG, SITE, 'lead', 'legacy', true)).toMatchObject({ id: 'legacy', status: 'partial' });
  });
});

describe('the store TTL removes expired partials without a read', () => {
  function siteObject(now: () => number) {
    const driver = nodeSqliteDriver();
    const storage: AlarmStorage & { alarm: number | null } = {
      alarm: null,
      sql: { exec: (query, ...params) => { const rows = driver.exec(query, ...params); return { toArray: () => rows }; } },
      transactionSync: (work) => driver.transaction(work),
      getAlarm: async () => storage.alarm,
      setAlarm: async (time) => { storage.alarm = time; },
      deleteAlarm: async () => { storage.alarm = null; },
    };
    const rpc = scheduledDocumentStore(storage, { name: 'site:test', now, hooks: { deliver: async () => {}, drainOutbox: async () => 0 } });
    let id = 0;
    return { storage, rpc, store: new SqlStore(durableObjectTransport(rpc as never), () => `doc${++id}`) };
  }

  it('arms the site object alarm for the partial expiry and deletes it there, keeping completed ones', async () => {
    const { partialExpiryFields } = await import('../../lib/form-submissions');
    let now = T0;
    const { storage, rpc, store: objectStore } = siteObject(() => now);
    const col = paths.submissions(ORG, SITE);
    await objectStore.setDoc(`${col}/partial`, { form_id: 'lead', status: 'partial', data: {}, ...partialExpiryFields({ partial_ttl_days: 7 }, new Date(T0)) });
    await objectStore.setDoc(`${col}/complete`, { form_id: 'lead', status: 'complete', data: {}, expires_at: null, delete_at: null });
    expect(storage.alarm).not.toBeNull();
    expect(storage.alarm!).toBeGreaterThanOrEqual(T0 + 7 * DAY);

    now = T0 + 7 * DAY - 1;
    await rpc.alarm();
    expect((await objectStore.listDocs(col)).map((d: any) => d.id).sort()).toEqual(['complete', 'partial']);

    now = storage.alarm!;
    await rpc.alarm();
    expect((await objectStore.listDocs(col)).map((d: any) => d.id)).toEqual(['complete']);
  });
});
