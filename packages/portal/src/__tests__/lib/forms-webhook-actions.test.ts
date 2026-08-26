import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const FORM = 'newsletter';

describe('form webhook actions', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    process.env.INTEGRATIONS_SECRET_KEY = 'test-integrations-secret-test-integrations-secret';
    vi.restoreAllMocks();
  });

  it('sends only allowlisted fields with an idempotency key and HMAC signature', async () => {
    const { encryptSecret } = await import('../../lib/secret-crypto');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook } = await import('../../lib/forms/webhook');
    await deliverFormWebhook({
      id: 'hook-one',
      type: 'webhook',
      config: {
        url: 'https://8.8.8.8/newsletter',
        fields: ['email'],
        webhook_id: 'hook-one',
        secret_enc: encryptSecret('shared-signing-secret'),
      },
    }, {
      orgId: ORG,
      siteId: SITE,
      formId: FORM,
      subject: { kind: 'submission', id: 'sub-one' },
      data: { email: 'person@example.com', internal_note: 'do not send' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.data).toEqual({ email: 'person@example.com' });
    expect(payload.data.internal_note).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(payload.id);
    expect(headers['X-Typeroll-Signature']).toMatch(/^v1=[a-f0-9]{64}$/);

    const { getStore } = await import('../../lib/datastore');
    const deliveries = await getStore().listDocs(paths.formWebhookDeliveries(ORG, SITE));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'delivered', attempts: 1, response_status: 204 });
  });

  it('refuses local and private destinations', async () => {
    const { parseWebhookUrl } = await import('../../lib/forms/webhook');
    expect(() => parseWebhookUrl('http://example.com/hook')).toThrow(/HTTPS/);
    expect(() => parseWebhookUrl('https://localhost/hook')).toThrow(/public host/);
    expect(() => parseWebhookUrl('https://127.0.0.1/hook')).toThrow(/public host/);
    expect(() => parseWebhookUrl('https://10.0.0.2/hook')).toThrow(/public host/);
  });

  it('retries transient responses and records the final attempt count', async () => {
    const { encryptSecret } = await import('../../lib/secret-crypto');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deliverFormWebhook } = await import('../../lib/forms/webhook');
    await deliverFormWebhook({
      id: 'hook-retry', type: 'webhook',
      config: {
        url: 'https://8.8.8.8/retry', fields: ['email'], webhook_id: 'hook-retry',
        secret_enc: encryptSecret('shared-signing-secret'),
      },
    }, {
      orgId: ORG, siteId: SITE, formId: FORM,
      subject: { kind: 'submission', id: 'sub-retry' },
      data: { email: 'person@example.com' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const { getStore } = await import('../../lib/datastore');
    const deliveries = await getStore().listDocs(paths.formWebhookDeliveries(ORG, SITE));
    expect(deliveries[0]).toMatchObject({ status: 'delivered', attempts: 3, response_status: 200 });
  });
});
