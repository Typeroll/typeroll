import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../index.js';
import { renderFormHtml } from '../render-form.js';
import { FORMS_RUNTIME_JS } from '../forms-runtime.js';
import { buildConsentRuntime } from '../consent-scripts.js';
import { CONVERSIONS_RUNTIME_JS } from '../form-conversions.js';
import {
  buildFormConversion,
  conversionEventId,
  conversionPageConfig,
  formConversionWarnings,
  postedAttribution,
  validateFormConversionSetting,
} from '../form-conversions.js';
import type { Form } from '../types.js';

const registry = buildCoreBlockRegistry();
const form = (id: string): Form => ({
  id, name: id, created_at: 'x', actions: [],
  steps: [{ id: 's1', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email' } }] }],
});
const embed = { submit_url: 'https://forms.example.test/api/forms/submit', submit_token: 'signed' };
const registration = {
  type: 'extension:inst:register-for-occurrence',
  result: {
    series_id: 'lunch', occurrence_id: 'nov', interest_only: false,
    conversion: { meta_event: 'CompleteRegistration', ga4_event: 'sign_up', content_name: 'AI-lunch', params: { series_id: 'lunch', occurrence_id: 'nov', interest_only: false } },
  },
};
const interest = {
  type: 'extension:inst:add-to-list',
  result: { conversion: { meta_event: 'Lead', ga4_event: 'generate_lead', content_name: 'AI-lunch', params: { series_id: 'lunch', occurrence_id: null, interest_only: true } } },
};

describe('buildFormConversion', () => {
  it('maps a registration and an interest-only sign-up from the app descriptor', () => {
    const reg = buildFormConversion({ form: { id: 'f' }, results: [registration], submissionId: 'abc123', attribution: { utm_campaign: 'nov', utm_content: 'ad-1' } })!;
    expect(reg).toEqual({
      event_id: 'tr_abc123', meta_event: 'CompleteRegistration', ga4_event: 'sign_up',
      params: { form_id: 'f', content_name: 'AI-lunch', series_id: 'lunch', occurrence_id: 'nov', interest_only: false, utm_campaign: 'nov', utm_content: 'ad-1' },
    });
    const lead = buildFormConversion({ form: { id: 'f' }, results: [interest], submissionId: 'def' })!;
    expect(lead.meta_event).toBe('Lead');
    expect(lead.ga4_event).toBe('generate_lead');
    expect(lead.params).toMatchObject({ occurrence_id: null, interest_only: true });
  });

  it('never carries anything but allowlisted identifiers, and drops unknown events', () => {
    const c = buildFormConversion({
      form: { id: 'f' }, submissionId: 'x',
      results: [{ type: 't', result: { conversion: { meta_event: 'Purchase', ga4_event: 'sign_up', params: { email: 'a@b.se', name: 'Ada', series_id: 'lunch' } } } }],
      attribution: { utm_source: 'meta', email: 'a@b.se' },
    })!;
    expect(c.meta_event).toBeNull();
    expect(c.ga4_event).toBe('sign_up');
    expect(JSON.stringify(c)).not.toMatch(/a@b\.se|Ada/);
    expect(Object.keys(c.params).sort()).toEqual(['form_id', 'series_id', 'utm_source']);
  });

  it('falls back to the form setting, and returns nothing without either', () => {
    expect(buildFormConversion({ form: { id: 'f', conversion: { meta_event: 'Lead', ga4_event: 'none', content_name: 'Newsletter' } }, results: [], submissionId: 'y' }))
      .toMatchObject({ meta_event: 'Lead', ga4_event: null, params: { content_name: 'Newsletter' } });
    expect(buildFormConversion({ form: { id: 'f' }, results: [{ type: 't', result: { ok: true } }], submissionId: 'y' })).toBeNull();
  });

  it('derives a stable event id from the submission id', () => {
    expect(conversionEventId('a/b c')).toBe('tr_abc');
    expect(postedAttribution({ _tr_utm_source: ' meta ', _tr_utm_term: '', _tr_email: 'x', utm_source: 'ignored' })).toEqual({ utm_source: 'meta' });
  });

  it('validates a form setting', () => {
    expect(validateFormConversionSetting({ meta_event: 'Lead' })).toBeNull();
    expect(validateFormConversionSetting({ meta_event: 'Purchase' })).toMatch(/meta_event/);
    expect(validateFormConversionSetting({ pixel: 1 })).toMatch(/not a known/);
  });
});

describe('conversionPageConfig and warnings', () => {
  const config = { meta_pixel__pixel_id: '1431081438779722', google_analytics__measurement_id: 'G-TVNDBF747F' };
  it('is on by default from render version 20 and can be forced either way', () => {
    expect(conversionPageConfig(config, 19)).toBeNull();
    expect(conversionPageConfig(config, 20)).toEqual({ meta: true, ga4: true });
    expect(conversionPageConfig({ ...config, form_conversions: 'on' }, 18)).toEqual({ meta: true, ga4: true });
    expect(conversionPageConfig({ ...config, form_conversions: 'off' }, 20)).toBeNull();
    expect(conversionPageConfig({}, 20)).toBeNull();
    expect(conversionPageConfig({ ...config, meta_pixel__capi_email_matching: true, meta_pixel__capi_email_notice: 'We share a coded email with Meta.' }, 20))
      .toMatchObject({ notice: 'We share a coded email with Meta.' });
  });

  it('warns about an app form on a site where nothing would fire', () => {
    const appForm = { actions: [{ type: 'extension:inst:register-for-occurrence', config: {} }] } as unknown as Form;
    expect(formConversionWarnings(appForm, { enabled: true, config }, 18)[0]).toMatch(/render version 20/);
    expect(formConversionWarnings(appForm, { enabled: true, config }, 20)).toEqual([]);
    expect(formConversionWarnings(appForm, { enabled: true, config: { ...config, form_conversions: 'off' } }, 20)[0]).toMatch(/off/);
    expect(formConversionWarnings({ actions: [] } as unknown as Form, null, 20)).toEqual([]);
  });
});

// ── Runtime ───────────────────────────────────────────────────────────────

let open: Window | null = null;
afterEach(async () => { await open?.happyDOM.close(); open = null; });

type Calls = { fbq: unknown[][]; gtag: unknown[][]; conversions: Array<Record<string, unknown>> };

function page(opts: { banner?: boolean; consent?: string; conversions?: string | null; url?: string; cookies?: string[]; forms?: string[]; renderVersion?: number }) {
  const window = new Window({ url: opts.url ?? 'https://site.example.test/event/lunch' });
  open = window;
  const doc = window.document;
  doc.documentElement.setAttribute('data-tr-render', String(opts.renderVersion ?? 20));
  if (opts.conversions !== null) doc.documentElement.setAttribute('data-tr-conversions', opts.conversions ?? '{"meta":true,"ga4":true,"gtm":true}');
  for (const cookie of opts.cookies ?? []) doc.cookie = cookie;
  // Same attributes as the consent runtime writes, so its later write replaces it.
  if (opts.consent) doc.cookie = `tr_consent=${opts.consent}; path=/; SameSite=Lax; Secure`;
  const calls: Calls = { fbq: [], gtag: [], conversions: [] };
  // The gated provider tags, as the Integrations app emits them behind the banner.
  const define = () => {
    const w = window as unknown as Record<string, unknown>;
    w.fbq = (...args: unknown[]) => { calls.fbq.push(args); };
    w.gtag = (...args: unknown[]) => { calls.gtag.push(args); };
    w.dataLayer = (w.dataLayer as unknown[]) ?? [];
  };
  if (!opts.banner) define();
  doc.body.innerHTML = (opts.forms ?? ['lunch']).map((id) => renderFormHtml(form(id), embed, { registry, renderVersion: opts.renderVersion ?? 20 } as never)).join('');
  doc.addEventListener('typeroll:conversion', (e) => calls.conversions.push((e as unknown as { detail: Record<string, unknown> }).detail));
  if (opts.banner) {
    // Stand-in for activate(): define the providers when consent arrives, then
    // the real consent runtime announces typeroll:consent-activated.
    doc.addEventListener('typeroll:consent', (e) => { if ((e as unknown as { detail: { choice: string } }).detail.choice === 'all') define(); });
    window.eval(buildConsentRuntime(false));
    if (opts.consent === 'all') define();
  }
  // BaseLayout puts the conversion API in <head> where conversions are on.
  if (opts.conversions !== null) window.eval(CONVERSIONS_RUNTIME_JS);
  window.eval(FORMS_RUNTIME_JS);
  doc.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, doc, calls };
}

function reply(window: Window, bodies: Array<{ status?: number; body: Record<string, unknown> }>) {
  const posts: FormData[] = [];
  window.fetch = (async (_url: string, init: RequestInit) => {
    posts.push(init.body as FormData);
    const next = bodies.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as never;
  return posts;
}

async function submit(window: Window, index = 0) {
  const el = window.document.querySelectorAll('form')[index]!;
  (el.querySelector('[name=email]') as unknown as { value: string }).value = 'visitor@example.test';
  el.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
}

const done = (id: string, meta = 'CompleteRegistration', ga4 = 'sign_up') => ({
  body: { v: 1, ok: true, done: true, form_id: 'lunch', results: [], conversion: { event_id: `tr_${id}`, meta_event: meta, ga4_event: ga4, params: { form_id: 'lunch', series_id: 'lunch', occurrence_id: 'nov', interest_only: false, utm_campaign: 'nov' } } },
});

describe('forms runtime conversions', () => {
  it('waits while consent is denied, then fires once when the visitor accepts on the same page', async () => {
    const { window, calls } = page({ banner: true, consent: 'necessary' });
    reply(window, [done('s1')]);
    await submit(window);
    expect(calls.fbq).toEqual([]);
    expect(calls.conversions).toEqual([expect.objectContaining({ event_id: 'tr_s1', queued: true, sent: [] })]);
    (window as unknown as { typerollConsent: { set(c: string): void } }).typerollConsent.set('all');
    expect(calls.fbq).toEqual([['track', 'CompleteRegistration', expect.objectContaining({ series_id: 'lunch', utm_campaign: 'nov' }), { eventID: 'tr_s1' }]]);
    expect(calls.gtag).toEqual([['event', 'sign_up', expect.objectContaining({ event_id: 'tr_s1' })]]);
    const layer = (window as unknown as { dataLayer: Array<Record<string, unknown>> }).dataLayer;
    expect(layer).toEqual([{ event: 'typeroll_conversion', typeroll_conversion: expect.objectContaining({ event_id: 'tr_s1', meta_event: 'CompleteRegistration' }) }]);
    // A second activation sends nothing again.
    (window as unknown as { typerollConsent: { set(c: string): void } }).typerollConsent.set('all');
    expect(calls.fbq).toHaveLength(1);
  });

  it('never fires when the visitor keeps refusing', async () => {
    const { window, calls } = page({ banner: true, consent: 'rejected' });
    reply(window, [done('s1')]);
    await submit(window);
    (window as unknown as { typerollConsent: { set(c: string): void } }).typerollConsent.set('necessary');
    expect(calls.fbq).toEqual([]);
    expect(calls.gtag).toEqual([]);
  });

  it('fires each of two registrations in one session, with their own event ids', async () => {
    const { window, calls } = page({ forms: ['lunch', 'lunch2'] });
    reply(window, [done('s1'), done('s2', 'Lead', 'generate_lead')]);
    // The first form is replaced by its success message; the second is next.
    await submit(window, 0);
    await submit(window, 0);
    expect(calls.fbq.map((c) => [c[1], (c[3] as { eventID: string }).eventID])).toEqual([['CompleteRegistration', 'tr_s1'], ['Lead', 'tr_s2']]);
    expect(calls.gtag.map((c) => c[1])).toEqual(['sign_up', 'generate_lead']);
  });

  it('fires nothing for a failed, full or invalid submission', async () => {
    const { window, calls } = page({});
    reply(window, [
      { status: 409, body: { v: 1, ok: false, retry: 'r', errors: [{ field: null, code: 'action_incomplete', message: 'This event is full.' }] } },
      { status: 400, body: { v: 1, ok: false, errors: [{ field: 'email', code: 'invalid_email', message: 'Enter an email' }] } },
    ]);
    await submit(window);
    await submit(window);
    expect(calls.fbq).toEqual([]);
    expect(calls.conversions).toEqual([]);
  });

  it('does nothing on a page without conversions, even when the reply carries one', async () => {
    const { window, calls } = page({ conversions: null });
    reply(window, [done('s1')]);
    await submit(window);
    expect(calls.fbq).toEqual([]);
  });

  it('posts campaign values from the URL, else the Attribution cookie, and Meta ids only with consent', async () => {
    const attr = encodeURIComponent(JSON.stringify({ v: 1, funnel_id: 'f', captured_at: 'x', expires_at: Date.now() + 1e6, values: { utm_source: 'meta', utm_content: 'ad-7' } }));
    const fromCookie = page({ cookies: [`tr_attr_last_v1=${attr}`, '_fbp=fb.1.1700000000000.123456'] });
    let posts = reply(fromCookie.window, [done('s1')]);
    await submit(fromCookie.window);
    expect(posts[0]!.get('_tr_utm_source')).toBe('meta');
    expect(posts[0]!.get('_tr_utm_content')).toBe('ad-7');
    expect(posts[0]!.get('_tr_consent')).toBe('none');
    expect(posts[0]!.get('_tr_fbp')).toBe('fb.1.1700000000000.123456');
    expect(posts[0]!.get('_tr_page')).toBe('https://site.example.test/event/lunch');

    const fromUrl = page({ url: 'https://site.example.test/event/lunch?utm_source=newsletter&fbclid=AbC_1', banner: true, consent: 'necessary', cookies: [`tr_attr_last_v1=${attr}`, '_fbp=fb.1.1700000000000.123456'] });
    posts = reply(fromUrl.window, [done('s2')]);
    await submit(fromUrl.window);
    expect(posts[0]!.get('_tr_utm_source')).toBe('newsletter');
    expect(posts[0]!.get('_tr_utm_content')).toBeNull();
    expect(posts[0]!.get('_tr_consent')).toBe('necessary');
    expect(posts[0]!.get('_tr_fbp')).toBeNull();
    expect(posts[0]!.get('_tr_fbc')).toBeNull();
  });

  it('follows an action redirect from render version 20 only', async () => {
    for (const [version, expected] of [[20, '/tack/'], [19, null]] as const) {
      const { window } = page({ renderVersion: version });
      let assigned: string | null = null;
      (window.location as unknown as { assign: (u: string) => void }).assign = (u: string) => { assigned = u; };
      reply(window, [{ body: { ...done('s1').body, redirect: '/tack/' } }]);
      await submit(window);
      await new Promise((r) => setTimeout(r, 700));
      expect(assigned).toBe(expected);
    }
  });
});

describe('the page conversion API', () => {
  type Api = { report(d: unknown): { status: string; sent: string[] } };
  const api = (window: Window) => (window as unknown as { typerollConversions: Api }).typerollConversions;

  it('lets a page script or widget report a conversion once, with campaign values and no answers', () => {
    const { window, calls } = page({ url: 'https://site.example.test/ai-planen?utm_campaign=nov' });
    const booking = { event_id: 'cal_booking_123', meta_event: 'Schedule', ga4_event: 'schedule', content_name: 'AI-planen', params: { booking_type: 'intro', email: 'a@b.se', value: 0, currency: 'SEK' } };
    expect(api(window).report(booking)).toEqual({ status: 'sent', sent: ['meta', 'ga4', 'gtm'] });
    expect(api(window).report(booking)).toEqual({ status: 'duplicate', sent: [] });
    expect(calls.fbq).toEqual([['track', 'Schedule', { content_name: 'AI-planen', booking_type: 'intro', value: 0, currency: 'SEK', utm_campaign: 'nov' }, { eventID: 'cal_booking_123' }]]);
    expect(JSON.stringify(calls)).not.toContain('a@b.se');
  });

  it('refuses descriptors without a stable id or a known event', () => {
    const { window, calls } = page({});
    expect(api(window).report({ event_id: 'x', meta_event: 'Lead' }).status).toBe('invalid');
    expect(api(window).report({ event_id: 'booking-1', meta_event: 'Purchase' }).status).toBe('invalid');
    expect(api(window).report(null).status).toBe('invalid');
    expect(calls.fbq).toEqual([]);
  });

  it('filters a conversion in an app endpoint reply the same way', async () => {
    const { window, calls } = page({});
    reply(window, [{ body: { ok: true, done: true, form_id: 'lunch', conversion: { event_id: 'app_claim_77', meta_event: 'SubmitApplication', ga4_event: 'nope', params: { listing_id: 'L1', company: 'Acme' } } } }]);
    await submit(window);
    expect(calls.fbq).toEqual([['track', 'SubmitApplication', { listing_id: 'L1' }, { eventID: 'app_claim_77' }]]);
    expect(calls.gtag).toEqual([]);
  });

  it('reports nothing where conversions are off', () => {
    const { window } = page({ conversions: null });
    expect((window as unknown as { typerollConversions?: Api }).typerollConversions).toBeUndefined();
  });
});
