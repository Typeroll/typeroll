// Form conversions through the real submit endpoint and runtime: the browser
// event and the Conversions API event share one event id (Meta dedupes on
// it), the server sends only what the cookie choice allows, a submission is
// sent once, and the test send creates nothing. Offline: Meta is a stub.
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { buildConsentRuntime, buildCoreBlockRegistry, CONVERSIONS_RUNTIME_JS, FORMS_RUNTIME_JS, paths, renderFormHtml } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

process.env.AUTH_TRUST_PROXY_HOPS = '1';
process.env.INTEGRATIONS_SECRET_KEY = 'unit-test-integrations-key-please-change-32+chars';

const ORG = 'orgone';
const SITE = 'mysite';
const PIXEL = '1431081438779722';
const FORM: Omit<Form, 'id'> = {
  name: 'Lunch', actions: [], created_at: new Date().toISOString(),
  conversion: { meta_event: 'Lead', ga4_event: 'generate_lead', content_name: 'AI-lunch' },
  steps: [{ id: 'main', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } }] }],
};

let ip = 0;
const metaCalls: Array<{ url: string; body: Record<string, any> }> = [];
const replies: string[] = [];

async function setup(extra: Record<string, unknown> = {}) {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'f'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  const { encryptSecret } = await import('../../lib/secret-crypto');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', language: 'sv', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/lunch`, FORM);
  await getStore().setDoc(paths.apps(ORG, SITE), { apps: { integrations: { enabled: true, config: {
    meta_pixel__pixel_id: PIXEL,
    meta_pixel__capi_access_token_enc: encryptSecret('capi-token-value'),
    meta_pixel__capi_test_event_code: 'TEST123',
    ...extra,
  } } } });
  const { signFormToken } = await import('../../lib/forms-signing');
  return signFormToken(ORG, SITE, 'lunch');
}

async function submit(token: string, opts: { consent?: 'all' | 'necessary'; url?: string } = {}) {
  const { POST } = await import('../../pages/api/forms/submit');
  const window = new Window({ url: opts.url ?? 'https://site.example.test/event/lunch?utm_campaign=nov&utm_content=ad-1' });
  const fbq: unknown[][] = [];
  try {
    const doc = window.document;
    doc.documentElement.setAttribute('data-tr-render', '20');
    doc.documentElement.setAttribute('data-tr-conversions', JSON.stringify({ meta: true }));
    doc.cookie = '_fbp=fb.1.1700000000000.987654; path=/';
    if (opts.consent) {
      doc.cookie = `tr_consent=${opts.consent}; path=/; SameSite=Lax; Secure`;
      window.eval(buildConsentRuntime(false));
    }
    (window as unknown as Record<string, unknown>).fbq = (...args: unknown[]) => { fbq.push(args); };
    doc.body.innerHTML = renderFormHtml({ id: 'lunch', ...FORM } as Form,
      { submit_url: 'https://forms.example.test/api/forms/submit', submit_token: token },
      { registry: buildCoreBlockRegistry(), lang: 'sv', renderVersion: 20 } as never);
    window.fetch = (async (_url: unknown, options?: { body?: FormData }) => {
      const fd = new FormData();
      for (const [k, v] of options!.body!.entries()) fd.append(k, String(v));
      const res = await POST({ request: new Request('http://localhost/api/forms/submit', {
        method: 'POST', headers: { 'x-forwarded-for': `10.20.0.${++ip}`, 'user-agent': 'TestBrowser/1.0', accept: 'application/json' }, body: fd,
      }) } as never) as Response;
      const text = await res.text();
      replies.push(text);
      return new Response(text, { status: res.status });
    }) as never;
    window.eval(CONVERSIONS_RUNTIME_JS);
    window.eval(FORMS_RUNTIME_JS);
    doc.dispatchEvent(new window.Event('DOMContentLoaded'));
    const form = doc.querySelector('form')!;
    (form.querySelector('input[name=email]') as unknown as { value: string }).value = 'Visitor@Example.test';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    for (let i = 0; i < 100 && !doc.querySelector('.form-done'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector('.form-done')).not.toBeNull();
  } finally {
    await window.happyDOM.close();
  }
  return { fbq };
}

beforeEach(() => {
  metaCalls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    metaCalls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('form conversions, browser and Conversions API', () => {
  it('sends the same event id from the browser and the server, with browser ids only under consent', async () => {
    const token = await setup();
    const { fbq } = await submit(token);
    expect(replies.at(-1)).toContain('conversion');
    expect(fbq).toHaveLength(1);
    const browserId = (fbq[0]![3] as { eventID: string }).eventID;
    expect(browserId).toMatch(/^tr_/);
    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]!.url).toBe(`https://graph.facebook.com/v21.0/${PIXEL}/events`);
    const event = metaCalls[0]!.body.data[0];
    expect(event).toMatchObject({ event_name: 'Lead', event_id: browserId, action_source: 'website', event_source_url: 'https://site.example.test/event/lunch' });
    expect(event.user_data).toEqual({ fbp: 'fb.1.1700000000000.987654', client_ip_address: expect.any(String), client_user_agent: 'TestBrowser/1.0' });
    expect(event.custom_data).toMatchObject({ form_id: 'lunch', content_name: 'AI-lunch', utm_campaign: 'nov', utm_content: 'ad-1' });
    expect(JSON.stringify(event)).not.toMatch(/visitor@example/i);
    expect(metaCalls[0]!.body.test_event_code).toBeUndefined();

    const { getStore } = await import('../../lib/datastore');
    const [saved] = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
    expect(saved!.attribution).toEqual({ utm_campaign: 'nov', utm_content: 'ad-1' });
    const { conversionStatus } = await import('../../lib/forms/conversions');
    const status = await conversionStatus(ORG, SITE);
    expect(status.recent[0]).toMatchObject({ form_id: 'lunch', event_id: browserId, consent: 'none', browser: { meta: 'fires' }, capi: { status: 'sent' } });
    expect(JSON.stringify(status)).not.toMatch(/visitor@example|capi-token-value|TestBrowser/i);
  });

  it('sends nothing to Meta without consent, unless email matching is on with its notice', async () => {
    let token = await setup();
    await submit(token, { consent: 'necessary' });
    expect(metaCalls).toEqual([]);
    const { conversionStatus } = await import('../../lib/forms/conversions');
    expect((await conversionStatus(ORG, SITE)).recent[0]).toMatchObject({ consent: 'necessary', browser: { meta: 'waits_for_consent' }, capi: { status: 'skipped', reason: 'no_user_data' } });

    token = await setup({ meta_pixel__capi_email_matching: true, meta_pixel__capi_email_notice: 'We share a coded version of your email with Meta to measure ads.' });
    // The page shows the notice (the runtime adds it), so the server may match.
    const submitWithNotice = async () => {
      const { POST } = await import('../../pages/api/forms/submit');
      const w = new Window({ url: 'https://site.example.test/event/lunch' });
      try {
        w.document.documentElement.setAttribute('data-tr-render', '20');
        w.document.documentElement.setAttribute('data-tr-conversions', JSON.stringify({ meta: true, notice: 'We share a coded version of your email with Meta to measure ads.' }));
        w.document.cookie = 'tr_consent=necessary; path=/; SameSite=Lax; Secure';
        w.document.cookie = '_fbp=fb.1.1700000000000.987654; path=/';
        w.eval(buildConsentRuntime(false));
        w.document.body.innerHTML = renderFormHtml({ id: 'lunch', ...FORM } as Form, { submit_url: 'https://forms.example.test/api/forms/submit', submit_token: token }, { registry: buildCoreBlockRegistry(), lang: 'sv' });
        w.fetch = (async (_u: unknown, o?: { body?: FormData }) => {
          const fd = new FormData();
          for (const [k, v] of o!.body!.entries()) fd.append(k, String(v));
          const res = await POST({ request: new Request('http://localhost/api/forms/submit', { method: 'POST', headers: { 'x-forwarded-for': `10.30.0.${++ip}`, accept: 'application/json' }, body: fd }) } as never) as Response;
          return new Response(await res.text(), { status: res.status });
        }) as never;
        w.eval(CONVERSIONS_RUNTIME_JS);
        w.eval(FORMS_RUNTIME_JS);
        w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
        const form = w.document.querySelector('form')!;
        expect(form.querySelector('.form-conversion-notice')?.textContent).toMatch(/coded version/);
        (form.querySelector('input[name=email]') as unknown as { value: string }).value = ' Visitor@Example.test ';
        form.dispatchEvent(new w.Event('submit', { cancelable: true }));
        for (let i = 0; i < 100 && !w.document.querySelector('.form-done'); i++) await new Promise((r) => setTimeout(r, 10));
      } finally { await w.happyDOM.close(); }
    };
    await submitWithNotice();
    expect(metaCalls).toHaveLength(1);
    const { createHash } = await import('node:crypto');
    expect(metaCalls[0]!.body.data[0].user_data).toEqual({ em: [createHash('sha256').update('visitor@example.test').digest('hex')] });
  });

  it('sends a submission once, also when its completion runs again', async () => {
    const token = await setup();
    await submit(token);
    const { getStore } = await import('../../lib/datastore');
    const [saved] = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
    const { recordFormConversion } = await import('../../lib/forms/conversions');
    const entry = await recordFormConversion({
      orgId: ORG, siteId: SITE, submissionId: saved!.id as string, form: { id: 'lunch', ...FORM } as Form,
      conversion: { event_id: `tr_${saved!.id}`, meta_event: 'Lead', ga4_event: null, params: { form_id: 'lunch' } },
      posted: { _rv: '20', _tr_consent: 'all', _tr_fbp: 'fb.1.1700000000000.987654' }, answers: {}, ip: '10.0.0.1', userAgent: 'x',
    });
    expect(entry?.capi).toEqual({ status: 'skipped', reason: 'already_sent' });
    expect(metaCalls).toHaveLength(1);
  });

  it('sends a test conversion with the test event code and creates no submission', async () => {
    await setup();
    const { sendTestConversion } = await import('../../lib/forms/conversions');
    const result = await sendTestConversion({ orgId: ORG, siteId: SITE, metaEvent: 'CompleteRegistration' });
    expect(result.ok).toBe(true);
    expect(metaCalls[0]!.body).toMatchObject({ test_event_code: 'TEST123', data: [{ event_name: 'CompleteRegistration', event_id: expect.stringMatching(/^tr_test_/) }] });
    expect(Object.keys(metaCalls[0]!.body.data[0].user_data)).toEqual(['external_id']);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs(paths.submissions(ORG, SITE))).toEqual([]);
  });

  it('sends nothing from the server below render version 20 unless conversions are turned on', async () => {
    const token = await setup();
    const { POST } = await import('../../pages/api/forms/submit');
    const fd = new FormData();
    fd.set('_token', token); fd.set('_protocol', '1'); fd.set('_rv', '19'); fd.set('email', 'a@example.test');
    fd.set('_tr_consent', 'all'); fd.set('_tr_fbp', 'fb.1.1700000000000.987654');
    const res = await POST({ request: new Request('http://localhost/api/forms/submit', { method: 'POST', headers: { 'x-forwarded-for': `10.40.0.${++ip}`, accept: 'application/json' }, body: fd }) } as never) as Response;
    const out = await res.json() as Record<string, unknown>;
    expect(out.done).toBe(true);
    expect(metaCalls).toEqual([]);
  });
});
