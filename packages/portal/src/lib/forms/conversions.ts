// Server side of form conversions (shared/form-conversions.ts): the optional
// Meta Conversions API send after a saved submission, the test send, and the
// tracking status log the Integrations page and MCP read.
//
// What may leave for Meta, by the visitor's cookie choice at submit (posted
// by the runtime as _tr_consent):
//   - no banner ("none") or "all": _fbp, _fbc, the client IP and user agent;
//   - email matching on and its notice shown on the form (_tr_notice): the
//     SHA-256 of the normalized email address, in every state;
//   - nothing else, and no event at all without some user data, because
//     Meta cannot use one.
// The event name and event id are the browser event's, so Meta counts the
// conversion once when both arrive.
//
// The status log keeps the last LOG_LIMIT outcomes per site: no contact data,
// no IP or user agent, only event names, the event id, the consent state and
// what was or would be sent.

import { createHash, randomUUID } from 'node:crypto';
import {
  collectStepFields,
  FORM_CONVERSION_KEYS,
  formConversionsEnabled,
  integrationConfigKey,
  INTEGRATION_PROVIDERS,
  paths,
  resolveRenderVersion,
  type AppState,
  type Form,
  type FormConversion,
  type SiteApps,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { resolveAppConfig } from '../apps/config';

export const META_GRAPH_VERSION = 'v21.0';
export const LOG_LIMIT = 50;
const CAPI_TIMEOUT_MS = 2_500;

export type ConsentAtSubmit = 'none' | 'all' | 'necessary' | 'rejected' | 'unset' | 'unknown';
export type BrowserOutcome = 'fires' | 'waits_for_consent' | 'not_configured' | 'no_event';
export type CapiOutcome =
  | { status: 'off' }
  | { status: 'sent'; http_status: number; test?: boolean }
  | { status: 'skipped'; reason: 'no_meta_event' | 'no_user_data' | 'already_sent' }
  | { status: 'failed'; http_status?: number; reason: string; test?: boolean };

export interface ConversionLogEntry {
  at: string;
  form_id: string;
  event_id: string;
  meta_event: string | null;
  ga4_event: string | null;
  consent: ConsentAtSubmit;
  browser: { meta: BrowserOutcome; ga4: BrowserOutcome; gtm: BrowserOutcome };
  capi: CapiOutcome;
  test?: boolean;
}

export const conversionLogPath = (orgId: string, siteId: string) =>
  `organizations/${orgId}/sites/${siteId}/conversion_log/default`;

function consentOf(value: unknown): ConsentAtSubmit {
  return value === 'none' || value === 'all' || value === 'necessary' || value === 'rejected' || value === 'unset'
    ? value : 'unknown';
}

function providerConfigured(config: Record<string, unknown>, id: string): boolean {
  const provider = INTEGRATION_PROVIDERS.find((p) => p.id === id);
  return Boolean(provider?.fields.every((f) => {
    const v = config[integrationConfigKey(id, f.key)];
    return typeof v === 'string' && f.pattern.test(v.trim());
  }));
}

/** Integrations state when conversions are on for this page's render version, else null. */
export async function conversionIntegrations(orgId: string, siteId: string, renderVersion: unknown): Promise<AppState | null> {
  const doc = await getStore().getDoc<SiteApps>(paths.apps(orgId, siteId));
  const state = doc?.apps?.integrations;
  if (!state?.enabled) return null;
  return formConversionsEnabled(state.config, resolveRenderVersion(Number(renderVersion))) ? state : null;
}

function browserOutcomes(config: Record<string, unknown>, conversion: FormConversion, consent: ConsentAtSubmit) {
  const now: BrowserOutcome = consent === 'none' || consent === 'all' ? 'fires' : 'waits_for_consent';
  const one = (configured: boolean, event: string | null): BrowserOutcome =>
    !configured ? 'not_configured' : !event ? 'no_event' : now;
  return {
    meta: one(providerConfigured(config, 'meta_pixel'), conversion.meta_event),
    ga4: one(providerConfigured(config, 'google_analytics'), conversion.ga4_event),
    gtm: one(providerConfigured(config, 'google_tag_manager'), conversion.meta_event ?? conversion.ga4_event),
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The first email answer of the form, normalized as Meta asks. */
export function emailAnswer(form: Pick<Form, 'steps'>, data: Record<string, unknown>): string | null {
  for (const step of form.steps ?? [])
    for (const field of collectStepFields(step.blocks))
      if (field.type === 'email' && typeof data[field.name] === 'string') {
        const email = (data[field.name] as string).trim().toLowerCase();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return email;
      }
  return null;
}

/** Meta user_data for this submission, or null when nothing may be sent. */
export function capiUserData(args: {
  consent: ConsentAtSubmit;
  posted: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  email: string | null;
  emailMatching: boolean;
}): Record<string, unknown> | null {
  const user: Record<string, unknown> = {};
  if (args.consent === 'none' || args.consent === 'all') {
    const fbp = args.posted._tr_fbp, fbc = args.posted._tr_fbc;
    if (typeof fbp === 'string' && /^fb\.\d\.\d+\.\d+$/.test(fbp)) user.fbp = fbp;
    if (typeof fbc === 'string' && /^fb\.\d\.\d+\.[A-Za-z0-9_-]{1,500}$/.test(fbc)) user.fbc = fbc;
    if (Object.keys(user).length) {
      if (args.ip) user.client_ip_address = args.ip;
      if (args.userAgent) user.client_user_agent = args.userAgent.slice(0, 500);
    }
  }
  if (args.emailMatching && args.posted._tr_notice === '1' && args.email) user.em = [sha256(args.email)];
  return Object.keys(user).length ? user : null;
}

/** The page the form was on, without its query string. */
export function eventSourceUrl(posted: Record<string, unknown>): string | null {
  const raw = posted._tr_page;
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

export async function sendCapiEvent(args: {
  pixelId: string;
  token: string;
  event: Record<string, unknown>;
  testEventCode?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status?: number; reason?: string }> {
  const body: Record<string, unknown> = { data: [args.event], access_token: args.token };
  if (args.testEventCode) body.test_event_code = args.testEventCode;
  try {
    const response = await (args.fetchImpl ?? fetch)(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(args.pixelId)}/events`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(CAPI_TIMEOUT_MS) },
    );
    if (response.ok) return { ok: true, status: response.status };
    const error = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
    // Meta's message names the problem (an expired token, a bad pixel); it
    // never echoes the token. Cut it short for the log.
    const message = typeof error?.error?.message === 'string' ? error.error.message.slice(0, 160) : 'Meta refused the event';
    return { ok: false, status: response.status, reason: message };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === 'TimeoutError' ? 'Meta did not answer in time' : 'Meta could not be reached' };
  }
}

export async function appendConversionLog(orgId: string, siteId: string, entry: ConversionLogEntry): Promise<void> {
  const store = getStore(), path = conversionLogPath(orgId, siteId);
  try {
    const doc = await store.getDoc<{ entries?: ConversionLogEntry[] }>(path);
    const entries = [entry, ...(doc?.entries ?? [])].slice(0, LOG_LIMIT);
    await store.setDoc(path, { entries, updated_at: entry.at });
  } catch (e) {
    console.error('The conversion log could not be written:', e instanceof Error ? e.message : 'unknown error');
  }
}

export async function readConversionLog(orgId: string, siteId: string): Promise<ConversionLogEntry[]> {
  const doc = await getStore().getDoc<{ entries?: ConversionLogEntry[] }>(conversionLogPath(orgId, siteId));
  return doc?.entries ?? [];
}

/**
 * After a completed submission: send the Conversions API event when it is
 * turned on, at most once per submission, and log the outcome. Never throws:
 * the visitor's submission already succeeded.
 */
export async function recordFormConversion(args: {
  orgId: string;
  siteId: string;
  submissionId: string;
  form: Pick<Form, 'id' | 'steps'>;
  conversion: FormConversion;
  posted: Record<string, unknown>;
  answers: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  fetchImpl?: typeof fetch;
}): Promise<ConversionLogEntry | null> {
  try {
    const state = await conversionIntegrations(args.orgId, args.siteId, args.posted._rv);
    if (!state) return null;
    const config = resolveAppConfig('integrations', state);
    const consent = consentOf(args.posted._tr_consent);
    const entry: ConversionLogEntry = {
      at: new Date().toISOString(),
      form_id: args.form.id,
      event_id: args.conversion.event_id,
      meta_event: args.conversion.meta_event,
      ga4_event: args.conversion.ga4_event,
      consent,
      browser: browserOutcomes(state.config, args.conversion, consent),
      capi: { status: 'off' },
    };
    const token = typeof config[FORM_CONVERSION_KEYS.capiToken] === 'string' ? config[FORM_CONVERSION_KEYS.capiToken] as string : '';
    const pixelId = String(state.config[integrationConfigKey('meta_pixel', 'pixel_id')] ?? '').trim();
    if (token && providerConfigured(state.config, 'meta_pixel')) {
      const user = capiUserData({
        consent,
        posted: args.posted,
        ip: args.ip,
        userAgent: args.userAgent,
        email: emailAnswer(args.form, args.answers),
        emailMatching: config[FORM_CONVERSION_KEYS.capiEmailMatching] === true,
      });
      if (!args.conversion.meta_event) entry.capi = { status: 'skipped', reason: 'no_meta_event' };
      else if (!user) entry.capi = { status: 'skipped', reason: 'no_user_data' };
      else {
        // One send per submission, also when a retry completes it again.
        const claimed = await getStore().compareAndUpdateDoc<Record<string, unknown>>(
          `${paths.submissions(args.orgId, args.siteId)}/${args.submissionId}`,
          (saved) => !saved.conversion_sent_at,
          { conversion_sent_at: entry.at },
        );
        if (!claimed) entry.capi = { status: 'skipped', reason: 'already_sent' };
        else {
          const source = eventSourceUrl(args.posted);
          const result = await sendCapiEvent({
            pixelId,
            token,
            fetchImpl: args.fetchImpl,
            event: {
              event_name: args.conversion.meta_event,
              event_time: Math.floor(Date.now() / 1000),
              event_id: args.conversion.event_id,
              action_source: 'website',
              ...(source ? { event_source_url: source } : {}),
              user_data: user,
              custom_data: args.conversion.params,
            },
          });
          entry.capi = result.ok
            ? { status: 'sent', http_status: result.status ?? 200 }
            : { status: 'failed', reason: result.reason ?? 'Meta refused the event', ...(result.status ? { http_status: result.status } : {}) };
        }
      }
    }
    await appendConversionLog(args.orgId, args.siteId, entry);
    return entry;
  } catch (e) {
    console.error('Recording a form conversion failed:', e instanceof Error ? e.message : 'unknown error');
    return null;
  }
}

/**
 * Send a synthetic Conversions API event with the site's test event code.
 * Creates no submission and no registration. User data is a random external
 * id, so no visitor's data is involved.
 */
export async function sendTestConversion(args: {
  orgId: string;
  siteId: string;
  metaEvent?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; entry?: ConversionLogEntry; error?: string }> {
  const doc = await getStore().getDoc<SiteApps>(paths.apps(args.orgId, args.siteId));
  const state = doc?.apps?.integrations;
  if (!state?.enabled) return { ok: false, error: 'Turn on the Integrations app first.' };
  if (!providerConfigured(state.config, 'meta_pixel')) return { ok: false, error: 'Add a Meta Pixel ID in the Integrations app first.' };
  const config = resolveAppConfig('integrations', state);
  const token = config[FORM_CONVERSION_KEYS.capiToken];
  const testCode = config[FORM_CONVERSION_KEYS.capiTestCode];
  if (typeof token !== 'string' || !token) return { ok: false, error: 'Add a Conversions API access token first.' };
  if (typeof testCode !== 'string' || !testCode) return { ok: false, error: 'Add the test event code from Events Manager → Test events first.' };
  const eventName = args.metaEvent === 'CompleteRegistration' ? 'CompleteRegistration' : 'Lead';
  const eventId = `tr_test_${randomUUID().replace(/-/g, '')}`;
  const result = await sendCapiEvent({
    pixelId: String(state.config[integrationConfigKey('meta_pixel', 'pixel_id')]).trim(),
    token,
    testEventCode: testCode,
    fetchImpl: args.fetchImpl,
    event: {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      user_data: { external_id: [sha256(randomUUID())] },
      custom_data: { form_id: 'test', content_name: 'Typeroll test conversion' },
    },
  });
  const entry: ConversionLogEntry = {
    at: new Date().toISOString(),
    form_id: 'test',
    event_id: eventId,
    meta_event: eventName,
    ga4_event: null,
    consent: 'unknown',
    browser: { meta: 'no_event', ga4: 'no_event', gtm: 'no_event' },
    capi: result.ok
      ? { status: 'sent', http_status: result.status ?? 200, test: true }
      : { status: 'failed', reason: result.reason ?? 'Meta refused the event', test: true, ...(result.status ? { http_status: result.status } : {}) },
    test: true,
  };
  await appendConversionLog(args.orgId, args.siteId, entry);
  return result.ok ? { ok: true, entry } : { ok: false, entry, error: entry.capi.status === 'failed' ? entry.capi.reason : undefined };
}

/** Status for the Integrations page and MCP: what is set up and the recent outcomes. */
export async function conversionStatus(orgId: string, siteId: string) {
  const doc = await getStore().getDoc<SiteApps>(paths.apps(orgId, siteId));
  const state = doc?.apps?.integrations;
  const config = state?.config ?? {};
  return {
    integrations_enabled: Boolean(state?.enabled),
    mode: typeof config[FORM_CONVERSION_KEYS.mode] === 'string' ? config[FORM_CONVERSION_KEYS.mode] : 'auto',
    providers: {
      meta_pixel: providerConfigured(config, 'meta_pixel'),
      google_analytics: providerConfigured(config, 'google_analytics'),
      google_tag_manager: providerConfigured(config, 'google_tag_manager'),
    },
    conversions_api: {
      token_set: Boolean(config[`${FORM_CONVERSION_KEYS.capiToken}_enc`]),
      test_event_code_set: typeof config[FORM_CONVERSION_KEYS.capiTestCode] === 'string' && Boolean(config[FORM_CONVERSION_KEYS.capiTestCode]),
      email_matching: config[FORM_CONVERSION_KEYS.capiEmailMatching] === true,
    },
    recent: await readConversionLog(orgId, siteId),
  };
}
