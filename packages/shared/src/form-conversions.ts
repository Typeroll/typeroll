// Form conversions: one ad-platform event per successful form submission,
// fired by the forms runtime through the Integrations app's Meta Pixel, GA4
// and Google Tag Manager, and optionally sent server-side to Meta's
// Conversions API with the same event id.
//
// The meaning of a submission comes from data, never from app code: a form
// action (Recurring Events registering for a date) returns a `conversion`
// descriptor in its public result, or the form itself names its events
// (`Form.conversion`). The server validates either against the allowlists
// below and answers the runtime with a ready-made `conversion`; the runtime
// only maps it to the configured providers. Form answers never reach an
// event: parameters are the descriptor's identifiers plus campaign values.

import type { Form } from './types.js';
import { INTEGRATION_PROVIDERS, integrationConfigKey } from './integrations.js';

/** From this render version form conversions are on by default. */
export const FORM_CONVERSIONS_RENDER_VERSION = 20;

/** Meta standard events a form submission may map to. */
export const CONVERSION_META_EVENTS = [
  'Lead',
  'CompleteRegistration',
  'Contact',
  'Schedule',
  'SubmitApplication',
  'Subscribe',
  'StartTrial',
] as const;
export type ConversionMetaEvent = typeof CONVERSION_META_EVENTS[number];

/** GA4 events a form submission may map to (recommended events first). */
export const CONVERSION_GA4_EVENTS = [
  'generate_lead',
  'sign_up',
  'contact',
  'schedule',
  'submit_application',
  'subscribe',
  'start_trial',
] as const;
export type ConversionGa4Event = typeof CONVERSION_GA4_EVENTS[number];

export const CONVERSION_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type ConversionUtmKey = typeof CONVERSION_UTM_KEYS[number];

/** Identifier parameters an app descriptor may carry, besides content_name. */
const DESCRIPTOR_PARAMS = ['series_id', 'occurrence_id', 'interest_only'] as const;

/** Reserved form fields the runtime posts; never stored as answers. */
export const CONVERSION_FIELD_PREFIX = '_tr_';

const MAX_PARAM = 100;
const MAX_UTM = 255;

/** Events a form names for itself (forms without an app descriptor). */
export interface FormConversionSetting {
  meta_event?: ConversionMetaEvent | 'none';
  ga4_event?: ConversionGa4Event | 'none';
  /** Label sent as content_name, e.g. "Newsletter". */
  content_name?: string;
}

/** What the submit endpoint returns to the runtime and the CAPI sender uses. */
export interface FormConversion {
  event_id: string;
  meta_event: ConversionMetaEvent | null;
  ga4_event: ConversionGa4Event | null;
  params: Record<string, string | boolean | null>;
}

/** Page-level switch and providers, written onto <html data-tr-conversions>. */
export interface ConversionPageConfig {
  meta?: true;
  ga4?: true;
  gtm?: true;
  /** Notice shown on conversion forms when email matching is on. */
  notice?: string;
}

export type FormConversionsMode = 'auto' | 'on' | 'off';

/** Integrations app keys for conversions (flat, beside the provider fields). */
export const FORM_CONVERSION_KEYS = {
  mode: 'form_conversions',
  capiToken: 'meta_pixel__capi_access_token',
  capiTestCode: 'meta_pixel__capi_test_event_code',
  capiEmailMatching: 'meta_pixel__capi_email_matching',
  capiEmailNotice: 'meta_pixel__capi_email_notice',
} as const;

const isMetaEvent = (v: unknown): v is ConversionMetaEvent =>
  typeof v === 'string' && (CONVERSION_META_EVENTS as readonly string[]).includes(v);
const isGa4Event = (v: unknown): v is ConversionGa4Event =>
  typeof v === 'string' && (CONVERSION_GA4_EVENTS as readonly string[]).includes(v);

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Event id from the submission id: stable across retries, unique per submission. */
export function conversionEventId(submissionId: string): string {
  return `tr_${submissionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96)}`;
}

/**
 * Campaign values posted by the runtime (`_tr_utm_source`, …). Only the five
 * utm keys, trimmed and capped; anything else is ignored.
 */
export function postedAttribution(data: Record<string, unknown>): Partial<Record<ConversionUtmKey, string>> {
  const out: Partial<Record<ConversionUtmKey, string>> = {};
  for (const key of CONVERSION_UTM_KEYS) {
    const value = cleanText(data[`${CONVERSION_FIELD_PREFIX}${key}`], MAX_UTM);
    if (value) out[key] = value;
  }
  return out;
}

/** A stored attribution object, validated the same way. */
export function sanitizeAttribution(value: unknown): Partial<Record<ConversionUtmKey, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<ConversionUtmKey, string>> = {};
  for (const key of CONVERSION_UTM_KEYS) {
    const v = cleanText((value as Record<string, unknown>)[key], MAX_UTM);
    if (v) out[key] = v;
  }
  return out;
}

/** Validate a form's own conversion setting; returns an error or null. */
export function validateFormConversionSetting(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'conversion must be an object';
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v))
    if (!['meta_event', 'ga4_event', 'content_name'].includes(key)) return `conversion.${key} is not a known setting`;
  if (v.meta_event !== undefined && v.meta_event !== 'none' && !isMetaEvent(v.meta_event))
    return `conversion.meta_event must be one of ${CONVERSION_META_EVENTS.join(', ')} or none`;
  if (v.ga4_event !== undefined && v.ga4_event !== 'none' && !isGa4Event(v.ga4_event))
    return `conversion.ga4_event must be one of ${CONVERSION_GA4_EVENTS.join(', ')} or none`;
  if (v.content_name !== undefined && (typeof v.content_name !== 'string' || v.content_name.length > MAX_PARAM))
    return `conversion.content_name must be text of at most ${MAX_PARAM} characters`;
  return null;
}

/**
 * The conversion for a completed submission, or null when nothing should be
 * sent. The first valid descriptor among the action results wins; without
 * one, the form's own setting applies. Campaign values come from the
 * submission's stored attribution, never from an app.
 */
export function buildFormConversion(args: {
  form: Pick<Form, 'id'> & { conversion?: FormConversionSetting };
  results: Array<{ type: string; result: Record<string, unknown> }>;
  submissionId: string;
  attribution?: unknown;
}): FormConversion | null {
  let meta: ConversionMetaEvent | null = null;
  let ga4: ConversionGa4Event | null = null;
  const params: Record<string, string | boolean | null> = { form_id: args.form.id.slice(0, MAX_PARAM) };
  let found = false;
  for (const { result } of args.results) {
    const d = result?.conversion;
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const descriptor = d as Record<string, unknown>;
    const m = isMetaEvent(descriptor.meta_event) ? descriptor.meta_event : null;
    const g = isGa4Event(descriptor.ga4_event) ? descriptor.ga4_event : null;
    if (!m && !g) continue;
    meta = m;
    ga4 = g;
    const name = cleanText(descriptor.content_name, MAX_PARAM);
    if (name) params.content_name = name;
    const p = descriptor.params && typeof descriptor.params === 'object' && !Array.isArray(descriptor.params)
      ? descriptor.params as Record<string, unknown> : {};
    for (const key of DESCRIPTOR_PARAMS) {
      const v = p[key];
      if (typeof v === 'boolean') params[key] = v;
      else if (v === null) params[key] = null;
      else {
        const s = cleanText(v, MAX_PARAM);
        if (s) params[key] = s;
      }
    }
    found = true;
    break;
  }
  if (!found) {
    const own = args.form.conversion;
    if (!own) return null;
    meta = isMetaEvent(own.meta_event) ? own.meta_event : null;
    ga4 = isGa4Event(own.ga4_event) ? own.ga4_event : null;
    if (!meta && !ga4) return null;
    const name = cleanText(own.content_name, MAX_PARAM);
    if (name) params.content_name = name;
  }
  for (const [key, value] of Object.entries(sanitizeAttribution(args.attribution))) params[key] = value.slice(0, MAX_PARAM);
  return { event_id: conversionEventId(args.submissionId), meta_event: meta, ga4_event: ga4, params };
}

function validValue(config: Record<string, unknown>, providerId: string): boolean {
  const provider = INTEGRATION_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return false;
  return provider.fields.every((field) => {
    const raw = config[integrationConfigKey(provider.id, field.key)];
    return typeof raw === 'string' && field.pattern.test(raw.trim());
  });
}

export function formConversionsMode(config: Record<string, unknown> | undefined): FormConversionsMode {
  const v = config?.[FORM_CONVERSION_KEYS.mode];
  return v === 'on' || v === 'off' ? v : 'auto';
}

/** Whether conversions are on for a site at this render version. */
export function formConversionsEnabled(config: Record<string, unknown> | undefined, renderVersion: number): boolean {
  const mode = formConversionsMode(config);
  return mode === 'on' || (mode === 'auto' && renderVersion >= FORM_CONVERSIONS_RENDER_VERSION);
}

/**
 * What the page tells the runtime: which providers to call. Null when
 * conversions are off or no provider is configured, so the attribute and
 * every runtime path stay absent.
 */
export function conversionPageConfig(
  config: Record<string, unknown> | undefined,
  renderVersion: number,
): ConversionPageConfig | null {
  if (!config || !formConversionsEnabled(config, renderVersion)) return null;
  const out: ConversionPageConfig = {};
  if (validValue(config, 'meta_pixel')) out.meta = true;
  if (validValue(config, 'google_analytics')) out.ga4 = true;
  if (validValue(config, 'google_tag_manager')) out.gtm = true;
  if (!out.meta && !out.ga4 && !out.gtm) return null;
  const notice = config[FORM_CONVERSION_KEYS.capiEmailMatching] === true
    ? cleanText(config[FORM_CONVERSION_KEYS.capiEmailNotice], 500) : null;
  if (notice) out.notice = notice;
  return out;
}

/**
 * Form editor warnings about conversions: a form whose app action or own
 * setting describes a conversion, on a site where nothing would fire. Campaign
 * values need no fields: the runtime posts them with every submission.
 */
export function formConversionWarnings(
  form: Pick<Form, 'actions'> & { conversion?: FormConversionSetting },
  integrations: { enabled?: boolean; config?: Record<string, unknown> } | null | undefined,
  renderVersion: number,
): string[] {
  const own = form.conversion && (isMetaEvent(form.conversion.meta_event) || isGa4Event(form.conversion.ga4_event));
  const app = (form.actions ?? []).some((a) => a.type.startsWith('extension:'));
  if (!own && !app) return [];
  const config = integrations?.enabled ? integrations.config ?? {} : null;
  const subject = own ? 'This form names conversion events' : 'Sign-ups through this form\'s app action can report conversions';
  if (!config || !(validValue(config, 'meta_pixel') || validValue(config, 'google_analytics') || validValue(config, 'google_tag_manager')))
    return own ? [`${subject}, but no Meta Pixel, Google Analytics 4 or Google Tag Manager is set up in the Integrations app, so none is sent.`] : [];
  const mode = formConversionsMode(config);
  if (mode === 'off') return [`${subject}, but form conversions are off in the Integrations app (form_conversions).`];
  if (mode === 'auto' && renderVersion < FORM_CONVERSIONS_RENDER_VERSION)
    return [`${subject}; they are sent from render version ${FORM_CONVERSIONS_RENDER_VERSION}, or set the Integrations setting form_conversions to "on". When you switch, remove any script of your own that fires a conversion on typeroll:form-success, or each submission counts twice.`];
  return [];
}
