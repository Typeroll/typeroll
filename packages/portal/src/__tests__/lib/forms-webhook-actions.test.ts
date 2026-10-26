import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form, FormAction } from '@typeroll/shared';

// Requests carry one forwarded hop, as behind the deployment's single trusted proxy.
process.env.AUTH_TRUST_PROXY_HOPS = '1';

const ORG = 'orgone';
const SITE = 'mysite';
const FORM = 'newsletter';
const SECRET = 'shared-signing-secret';

async function webhookAction(id: string, url = `https://8.8.8.8/${id}`): Promise<FormAction> {
  const { encryptSecret } = await import('../../lib/secret-crypto');
  return { id, type: 'webhook', config: { url, fields: ['email'], webhook_id: id, secret_enc: encryptSecret(SECRET) } };
}

async function saveForm(actions: FormAction[]): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const form: Omit<Form, 'id'> = {
    name: 'Newsletter',
    actions,
    created_at: new Date().toISOString(),
    steps: [{ id: 'contact', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } }] }],
  };
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/${FORM}`, form);
}

const context = (submissionId: string) => ({
  orgId: ORG, siteId: SITE, formId: FORM,
  subject: { kind: 'submission' as const, id: submissionId },
  data: { email: 'person@example.com', internal_note: 'do not send' },
});

async function deliveries(): Promise<Array<Record<string, any>>> {
  const { getStore } = await import('../../lib/datastore');
  return getStore().listDocs<Record<string, any>>(paths.formWebhookDeliveries(ORG, SITE));
}

async function runDue(at: number) {
  const { runDueScheduledWork } = await import('../../lib/scheduling/worker');
  return runDueScheduledWork(new Date(at));
}

/** A receiver that never answers; the request ends only when it is aborted. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')));
  }));
}

function sent(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const [, init] = fetchMock.mock.calls[index] as [URL, RequestInit];
  return { headers: init.headers as Record<string, string>, body: String(init.body) };
}

function signatureValid(request: { headers: Record<string, string>; body: string }): boolean {
  const expected = crypto.createHmac('sha256', SECRET).update(`${request.headers['X-Typeroll-Timestamp']}.${request.body}`).digest('hex');
  return request.headers['X-Typeroll-Signature'] === `v1=${expected}`;
}

describe('form webhook actions', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'test-integrations-secret-test-integrations-secret';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends only allowlisted fields with an idempotency key and HMAC signature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook } = await import('../../lib/forms/webhook');
    await deliverFormWebhook(await webhookAction('hook-one'), context('sub-one'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = sent(fetchMock, 0);
    const payload = JSON.parse(request.body);
    expect(payload.data).toEqual({ email: 'person@example.com' });
    expect(payload.data.internal_note).toBeUndefined();
    expect(request.headers['Idempotency-Key']).toBe(payload.id);
    expect(signatureValid(request)).toBe(true);

    const saved = await deliveries();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: 'delivered', attempts: 1, response_status: 204, payload: null });
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs('scheduled_work')).toHaveLength(0);
  });

  it('refuses local and private destinations', async () => {
    const { parseWebhookUrl } = await import('../../lib/forms/webhook');
    expect(() => parseWebhookUrl('http://example.com/hook')).toThrow(/HTTPS/);
    expect(() => parseWebhookUrl('https://localhost/hook')).toThrow(/public host/);
    expect(() => parseWebhookUrl('https://127.0.0.1/hook')).toThrow(/public host/);
    expect(() => parseWebhookUrl('https://10.0.0.2/hook')).toThrow(/public host/);
  });

  it('makes one attempt inside the request and retries in the background with the same event', async () => {
    const action = await webhookAction('hook-retry');
    await saveForm([action]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook } = await import('../../lib/forms/webhook');
    const before = Date.now();
    // A transient failure is not an error for the caller: a retry is queued.
    await deliverFormWebhook(action, context('sub-retry'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [pending] = await deliveries();
    expect(pending).toMatchObject({ status: 'pending', attempts: 1, response_status: 503, last_error: 'Webhook responded with HTTP 503' });
    const due = Date.parse(pending!.next_attempt_at);
    expect(due).toBeGreaterThanOrEqual(before + 60_000);
    expect(due).toBeLessThan(Date.now() + 61_000);

    // Not yet due: the sweep leaves it alone.
    await runDue(Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await runDue(due + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = sent(fetchMock, 0);
    const second = sent(fetchMock, 1);
    expect(second.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
    expect(second.headers['X-Typeroll-Event-Id']).toBe(first.headers['X-Typeroll-Event-Id']);
    expect(second.body).toBe(first.body);
    expect(signatureValid(first)).toBe(true);
    expect(signatureValid(second)).toBe(true);
    const [delivered] = await deliveries();
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 2, response_status: 200, payload: null, next_attempt_at: null });

    // A repeated sweep or duplicate delivery of the work entry sends nothing.
    await runDue(due + 10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt limit and keeps the failure visible', async () => {
    const action = await webhookAction('hook-down');
    await saveForm([action]);
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook, MAX_ATTEMPTS } = await import('../../lib/forms/webhook');
    await deliverFormWebhook(action, context('sub-down'));
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      const [delivery] = await deliveries();
      if (delivery!.status !== 'pending') break;
      await runDue(Date.parse(delivery!.next_attempt_at) + 1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const [failed] = await deliveries();
    expect(failed).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, response_status: 502, last_error: 'Webhook responded with HTTP 502', payload: null });
    await runDue(Date.now() + 7 * 86_400_000);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('does not retry a non-retryable response and reports it as failed', async () => {
    const action = await webhookAction('hook-gone');
    await saveForm([action]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 410 }));
    vi.stubGlobal('fetch', fetchMock);
    const { runFormActions } = await import('../../lib/forms/actions');
    const result = await runFormActions({ actions: [action] }, context('sub-gone'));
    expect(result).toEqual({ ran: [], failed: ['webhook'] });
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 1, response_status: 410 });
    await runDue(Date.now() + 86_400_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never sends the same attempt twice when retries run concurrently', async () => {
    const action = await webhookAction('hook-race');
    await saveForm([action]);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook, retryFormWebhookDelivery } = await import('../../lib/forms/webhook');
    await deliverFormWebhook(action, context('sub-race'));
    const [pending] = await deliveries();
    const at = Date.parse(pending!.next_attempt_at) + 1;
    const source = `${paths.formWebhookDeliveries(ORG, SITE)}/${pending!.id}`;

    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 200 })), 50)));
    await Promise.all([retryFormWebhookDelivery(source, at), retryFormWebhookDelivery(source, at), retryFormWebhookDelivery(source, at)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('never sends the same attempt twice when sweeps overlap', async () => {
    const action = await webhookAction('hook-sweeps');
    await saveForm([action]);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook } = await import('../../lib/forms/webhook');
    await deliverFormWebhook(action, context('sub-sweeps'));
    const [pending] = await deliveries();
    const at = Date.parse(pending!.next_attempt_at) + 1;

    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 204 })), 50)));
    await Promise.all([runDue(at), runDue(at), runDue(at)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('attempts at most three webhooks inside one run and delivers the rest in the background', async () => {
    const actions = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => webhookAction(`hook-${id}`)));
    await saveForm(actions);
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { runFormActions, MAX_SYNC_WEBHOOKS } = await import('../../lib/forms/actions');
    expect(MAX_SYNC_WEBHOOKS).toBe(3);
    const result = await runFormActions({ actions }, context('sub-many'));
    expect(result.failed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const saved = await deliveries();
    expect(saved.filter((d) => d.status === 'delivered')).toHaveLength(3);
    const queued = saved.filter((d) => d.status === 'pending');
    expect(queued).toHaveLength(2);
    expect(queued.every((d) => d.attempts === 0 && Date.parse(d.next_attempt_at) <= Date.now())).toBe(true);

    await runDue(Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect((await deliveries()).every((d) => d.status === 'delivered')).toBe(true);
  });

  it('ends pending retries when the webhook is removed from the form', async () => {
    const action = await webhookAction('hook-removed');
    await saveForm([action]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook } = await import('../../lib/forms/webhook');
    await deliverFormWebhook(action, context('sub-removed'));
    await saveForm([]);
    const [pending] = await deliveries();
    await runDue(Date.parse(pending!.next_attempt_at) + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', last_error: 'Webhook is no longer configured on this form', payload: null });
  });

  it('answers the visitor without waiting for a slow receiver', async () => {
    process.env.FORMS_HMAC_SECRET = 'g'.repeat(48);
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
    const action = await webhookAction('hook-slow');
    await saveForm([action, await webhookAction('hook-slow-2'), await webhookAction('hook-slow-3'), await webhookAction('hook-slow-4')]);
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { signFormToken } = await import('../../lib/forms-signing');
    const { POST } = await import('../../pages/api/forms/submit');
    const body = new FormData();
    body.set('_token', signFormToken(ORG, SITE, FORM));
    body.set('_protocol', '1');
    body.set('email', 'person@example.com');
    const started = Date.now();
    const res = await POST({ request: new Request('http://localhost/api/forms/submit', {
      method: 'POST', headers: { 'x-forwarded-for': '10.9.0.1', accept: 'application/json' }, body,
    }) } as never) as Response;
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, done: true });
    // One short attempt, within the run's shared budget, instead of 3 × 8 s per webhook.
    expect(elapsed).toBeLessThan(4_500);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    const saved = await deliveries();
    expect(saved).toHaveLength(4);
    expect(saved.every((d) => d.status === 'pending' && typeof d.payload === 'string')).toBe(true);
    expect(await getStore().listDocs('scheduled_work')).toHaveLength(4);
  }, 15_000);
});
