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

/**
 * Identifier parameters a descriptor may carry, besides content_name: ids
 * and categories an app or page defines, never answers. Text values are
 * capped at 100 characters, `value` is a number and `currency` an ISO code.
 */
export const CONVERSION_PARAMS = [
  'series_id', 'occurrence_id', 'interest_only',
  'content_category', 'content_type', 'content_ids',
  'listing_id', 'booking_type', 'value', 'currency',
] as const;
const DESCRIPTOR_PARAMS = CONVERSION_PARAMS;

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
  params: Record<string, string | number | boolean | null>;
}

/** Allowlisted descriptor parameters, cleaned. Same rules as the browser runtime. */
export function descriptorParams(p: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of CONVERSION_PARAMS) {
    const v = p[key];
    if (key === 'value') { if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out.value = v; continue; }
    if (key === 'currency') { if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) out.currency = v; continue; }
    if (typeof v === 'boolean') out[key] = v;
    else if (v === null) out[key] = null;
    else {
      const text = cleanText(typeof v === 'number' ? String(v) : v, MAX_PARAM);
      if (text) out[key] = text;
    }
  }
  return out;
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
  const params: Record<string, string | number | boolean | null> = { form_id: args.form.id.slice(0, MAX_PARAM) };
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
    Object.assign(params, descriptorParams(p));
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

/**
 * The page-wide conversion API, emitted once in <head> where conversions are
 * on (BaseLayout). window.typerollConversions.report(descriptor) is the one
 * way anything on the page reports a conversion: the forms runtime after a
 * submission (Core's own or an app endpoint's reply), an Extension component
 * through context.conversions.report, or a site script (a booking widget's
 * success callback). It validates the descriptor against the same lists as
 * the server, adds the page's campaign values, waits for cookie consent in
 * memory and fires once per event id through Meta Pixel, GA4 and Google Tag
 * Manager. It answers { status: "sent" | "queued" | "duplicate" | "invalid"
 * | "off", sent: [...] } and announces each outcome as typeroll:conversion.
 *
 * descriptor: { event_id, meta_event?, ga4_event?, content_name?, params? }
 * where event_id is 4-100 characters of A-Z a-z 0-9 _ - and stable for the
 * thing that happened (a booking id), so a repeat never counts twice.
 */
export const CONVERSIONS_RUNTIME_JS = `(function(){
"use strict";
if(window.typerollConversions)return;
var META=${JSON.stringify(CONVERSION_META_EVENTS)},GA4=${JSON.stringify(CONVERSION_GA4_EVENTS)},PARAMS=${JSON.stringify(CONVERSION_PARAMS)},UTM=${JSON.stringify(CONVERSION_UTM_KEYS)};
var CFG=null,FIRED={},PENDING=[];
function cfg(){if(CFG===null){CFG=false;try{var a=document.documentElement.getAttribute("data-tr-conversions");if(a)CFG=JSON.parse(a)||false}catch(e){CFG=false}}return CFG}
function consent(){try{var c=window.typerollConsent;if(!c||typeof c.get!=="function")return "none";return c.get()||"unset"}catch(e){return "unset"}}
function granted(){var s=consent();return s==="none"||s==="all"}
function cookie(name){try{var m=document.cookie.match(new RegExp("(?:^|;\\s*)"+name+"=([^;]+)"));return m?decodeURIComponent(m[1]):""}catch(e){return ""}}
function attr(name){var raw=cookie(name);if(!raw)return null;try{var x=JSON.parse(raw);return x&&x.v===1&&x.expires_at>Date.now()&&x.values&&typeof x.values==="object"?x.values:null}catch(e){return null}}
function campaign(){var q,out={},any=false;try{q=new URLSearchParams(location.search)}catch(e){q=new URLSearchParams()}
  UTM.forEach(function(k){var v=(q.get(k)||"").trim();if(v){out[k]=v.slice(0,100);any=true}});
  if(!any){var s=attr("tr_attr_last_v1")||attr("tr_attr_first_v1")||{};UTM.forEach(function(k){var v=typeof s[k]==="string"?s[k].trim():"";if(v)out[k]=v.slice(0,100)})}
  return out}
function text(v){if(typeof v==="number")v=String(v);if(typeof v!=="string")return null;v=v.replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();return v?v.slice(0,100):null}
function clean(d){if(!d||typeof d!=="object"||typeof d.event_id!=="string"||!/^[A-Za-z0-9_-]{4,100}$/.test(d.event_id))return null;
  var m=META.indexOf(d.meta_event)>=0?d.meta_event:null,g=GA4.indexOf(d.ga4_event)>=0?d.ga4_event:null;if(!m&&!g)return null;
  var p={},src=d.params&&typeof d.params==="object"?d.params:{};
  var form=text(src.form_id);if(form)p.form_id=form;var name=text(d.content_name);if(name)p.content_name=name;
  PARAMS.forEach(function(k){var v=src[k];if(k==="value"){if(typeof v==="number"&&isFinite(v)&&v>=0)p.value=v;return}if(k==="currency"){if(typeof v==="string"&&/^[A-Z]{3}$/.test(v))p.currency=v;return}if(typeof v==="boolean"||v===null)p[k]=v;else{var t=text(v);if(t)p[k]=t}});
  var u=campaign();UTM.forEach(function(k){var v=text(src[k])||u[k];if(v)p[k]=v});
  return {event_id:d.event_id,meta_event:m,ga4_event:g,params:p}}
function send(c){var conf=cfg(),sent=[],p={};Object.keys(c.params).forEach(function(k){p[k]=c.params[k]});
  if(conf.meta&&c.meta_event&&typeof window.fbq==="function"){try{window.fbq("track",c.meta_event,p,{eventID:c.event_id});sent.push("meta")}catch(e){}}
  if(conf.ga4&&c.ga4_event&&typeof window.gtag==="function"){try{window.gtag("event",c.ga4_event,Object.assign({},p,{event_id:c.event_id}));sent.push("ga4")}catch(e){}}
  if(conf.gtm&&Array.isArray(window.dataLayer)){window.dataLayer.push({event:"typeroll_conversion",typeroll_conversion:Object.assign({},p,{event_id:c.event_id,meta_event:c.meta_event,ga4_event:c.ga4_event})});sent.push("gtm")}
  FIRED[c.event_id]=1;return sent}
function announce(c,sent,queued){try{document.dispatchEvent(new CustomEvent("typeroll:conversion",{detail:{event_id:c.event_id,meta_event:c.meta_event,ga4_event:c.ga4_event,consent:consent(),sent:sent,queued:queued}}))}catch(e){}}
function report(d){if(!cfg())return {status:"off",sent:[]};var c=clean(d);if(!c)return {status:"invalid",sent:[]};
  if(FIRED[c.event_id]||PENDING.some(function(x){return x.event_id===c.event_id}))return {status:"duplicate",sent:[]};
  if(!granted()){PENDING.push(c);announce(c,[],true);return {status:"queued",sent:[]}}
  var sent=send(c);announce(c,sent,false);return {status:"sent",sent:sent}}
document.addEventListener("typeroll:consent-activated",function(){if(!granted())return;var q=PENDING;PENDING=[];q.forEach(function(c){if(!FIRED[c.event_id])announce(c,send(c),false)})});
/* The reserved fields a submission to Core's endpoint carries for conversions:
   campaign values, the cookie choice, the page, and Meta's ids only with consent. */
function fields(){var o={},u=campaign();UTM.forEach(function(k){if(u[k])o["_tr_"+k]=u[k]});o._tr_consent=consent();o._tr_page=location.origin+location.pathname;
  if(granted()&&cfg().meta){var fbp=cookie("_fbp"),fbc=cookie("_fbc"),id="";try{id=(new URLSearchParams(location.search).get("fbclid")||"").trim()}catch(e){}
    if(/^fb\\.\\d\\.\\d+\\.\\d+$/.test(fbp))o._tr_fbp=fbp;if(/^fb\\.\\d\\.\\d+\\.[A-Za-z0-9_-]{1,500}$/.test(fbc))o._tr_fbc=fbc;else if(/^[A-Za-z0-9_-]{1,500}$/.test(id))o._tr_fbc="fb.1."+Date.now()+"."+id}
  return o}
window.typerollConversions={report:report,consent:consent,fields:fields};
})();`;
