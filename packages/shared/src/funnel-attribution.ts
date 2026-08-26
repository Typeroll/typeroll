import type {
  FunnelAttributionConfig,
  FunnelAttributionRule,
} from './types.js';

const PARAM_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PERSONAL_NAMES = new Set([
  'email', 'e-mail', 'mail', 'name', 'first_name', 'firstname', 'last_name',
  'lastname', 'full_name', 'fullname', 'phone', 'phone_number', 'phonenumber',
  'telephone', 'mobile', 'address', 'street_address', 'streetaddress',
]);

function isPersonalParam(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[.-]/g, '_');
  if (PERSONAL_NAMES.has(normalized)) return true;
  return /(?:^|_)(?:email|e_mail|mail|phone|phone_number|phonenumber|telephone|mobile|first_name|firstname|last_name|lastname|full_name|fullname|address|street_address|streetaddress)(?:_|$)/.test(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeValue(value: unknown, maxLength = 255): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && !CONTROL_RE.test(value)
    && !value.includes('\ufffd');
}

/** Validate app config before it can reach a customer-site build. */
export function validateFunnelAttributionConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.funnels)) {
    return ['funnels must be an array'];
  }
  if (value.funnels.length > 50) errors.push('funnels may contain at most 50 rules');
  const allowPersonal = value.allow_personal_data === true;
  const allowSyntheticFallbacks = value.allow_synthetic_fallbacks === true;
  const ids = new Set<string>();

  value.funnels.forEach((raw, index) => {
    const at = `funnels[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push(`${at}.id is invalid`);
    else if (ids.has(raw.id)) errors.push(`${at}.id must be unique`);
    else ids.add(raw.id);

    if (raw.source !== undefined && raw.source !== 'current_url' && raw.source !== 'current_or_stored') {
      errors.push(`${at}.source is invalid`);
    }
    if (raw.precedence !== undefined && raw.precedence !== 'source_over_target' && raw.precedence !== 'target_over_source') {
      errors.push(`${at}.precedence is invalid`);
    }
    if (raw.page_paths !== undefined) {
      if (!Array.isArray(raw.page_paths) || raw.page_paths.length > 50) errors.push(`${at}.page_paths is invalid`);
      else for (const path of raw.page_paths) {
        if (!isSafeValue(path, 200) || !path.startsWith('/')) errors.push(`${at}.page_paths contains an invalid path`);
      }
    }

    if (!Array.isArray(raw.parameters) || raw.parameters.length < 1 || raw.parameters.length > 32) {
      errors.push(`${at}.parameters must contain 1–32 entries`);
    } else {
      const outputs = new Set<string>();
      raw.parameters.forEach((p, pIndex) => {
        const pt = `${at}.parameters[${pIndex}]`;
        if (!isRecord(p) || typeof p.from !== 'string' || !PARAM_RE.test(p.from)) {
          errors.push(`${pt}.from is invalid`);
          return;
        }
        const to = typeof p.to === 'string' && p.to ? p.to : p.from;
        if (!PARAM_RE.test(to)) errors.push(`${pt}.to is invalid`);
        if (outputs.has(to)) errors.push(`${pt}.to must be unique within the funnel`);
        outputs.add(to);
        if (!allowPersonal && (isPersonalParam(p.from) || isPersonalParam(to))) {
          errors.push(`${pt} forwards personal data; enable allow_personal_data explicitly to allow it`);
        }
        const max = p.max_length === undefined ? 255 : Number(p.max_length);
        if (!Number.isInteger(max) || max < 1 || max > 1024) errors.push(`${pt}.max_length must be 1–1024`);
        if (p.fallback !== undefined && !isSafeValue(p.fallback, Number.isInteger(max) ? max : 255)) {
          errors.push(`${pt}.fallback is invalid or too long`);
        }
        if (p.fallback !== undefined && !allowSyntheticFallbacks) {
          errors.push(`${pt}.fallback requires allow_synthetic_fallbacks=true because it creates attribution when no incoming or stored value exists`);
        }
      });
    }

    if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 50) {
      errors.push(`${at}.targets must contain 1–50 entries`);
    } else raw.targets.forEach((target, tIndex) => {
      const tt = `${at}.targets[${tIndex}]`;
      if (!isRecord(target) || target.type !== 'link') {
        errors.push(`${tt}.type must be link`);
        return;
      }
      if (target.protocol !== undefined && target.protocol !== 'https:') errors.push(`${tt}.protocol must be https:`);
      if (typeof target.host !== 'string' || !HOST_RE.test(target.host.toLowerCase())) errors.push(`${tt}.host is invalid`);
      if (!isSafeValue(target.path, 500) || !target.path.startsWith('/')) errors.push(`${tt}.path is invalid`);
      if (target.click_event !== undefined && (typeof target.click_event !== 'string' || !EVENT_RE.test(target.click_event))) {
        errors.push(`${tt}.click_event is invalid`);
      }
      if (target.destination !== undefined && !isSafeValue(target.destination, 80)) errors.push(`${tt}.destination is invalid`);
    });

    if (raw.storage !== undefined) {
      if (!isRecord(raw.storage)) errors.push(`${at}.storage must be an object`);
      else if (raw.storage.enabled === true) {
        if (raw.source !== 'current_or_stored') errors.push(`${at}.source must be current_or_stored when storage is enabled`);
        const ttl = raw.storage.ttl_days ?? 30;
        if (!Number.isInteger(ttl) || Number(ttl) < 1 || Number(ttl) > 365) errors.push(`${at}.storage.ttl_days must be 1–365`);
        if (raw.storage.touch !== undefined && !['first_touch', 'last_touch', 'both'].includes(String(raw.storage.touch))) errors.push(`${at}.storage.touch is invalid`);
        if (raw.storage.read_touch !== undefined && !['first_touch', 'last_touch'].includes(String(raw.storage.read_touch))) errors.push(`${at}.storage.read_touch is invalid`);
        if (raw.storage.consent !== undefined && raw.storage.consent !== 'optional') errors.push(`${at}.storage.consent must be optional`);
        if (raw.storage.cookie_domain !== undefined && (typeof raw.storage.cookie_domain !== 'string' || !HOST_RE.test(raw.storage.cookie_domain.replace(/^\./, '').toLowerCase()))) {
          errors.push(`${at}.storage.cookie_domain is invalid`);
        }
      }
    }
  });

  if (JSON.stringify(value).length > 32_768) errors.push('funnel attribution config exceeds 32 KiB');
  return errors;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Build the small browser runtime injected by BaseLayout. It exposes
 * `window.TyperollFunnels.init(root)` so dynamically mounted blocks can use
 * the same initializer without a global MutationObserver.
 */
export function buildFunnelAttributionRuntime(
  config: FunnelAttributionConfig,
  analyticsRequiresConsent = false,
  firstPartyAnalytics?: { endpoint: string; token: string },
): string {
  if (!config.funnels.length) return '';
  return `(function(){
var C=${safeJson(config)},ANALYTICS_CONSENT=${analyticsRequiresConsent ? 'true' : 'false'},FIRST_PARTY=${safeJson(firstPartyAnalytics ?? null)},FIRST='tr_attr_first_v1',LAST='tr_attr_last_v1',bound=new WeakSet();
function good(v,max){return typeof v==='string'&&v.length>0&&v.length<=(max||255)&&!/[\\u0000-\\u001f\\u007f]/.test(v)&&v.indexOf('\\ufffd')<0}
function cookie(n){var m=document.cookie.match(new RegExp('(?:^|;\\\\s*)'+n+'=([^;]+)'));if(!m)return null;try{var x=JSON.parse(decodeURIComponent(m[1]));return x&&x.v===1&&x.expires_at>Date.now()?x:null}catch(e){return null}}
function domain(s){return s&&s.cookie_domain?'; Domain='+s.cookie_domain:''}
function erase(n,s){document.cookie=n+'=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax; Secure'+domain(s)}
function consent(){return /(?:^|;\\s*)tr_consent=all(?:;|$)/.test(document.cookie)}
function current(f){var q=new URLSearchParams(location.search),o={};f.parameters.forEach(function(p){var v=q.get(p.from),m=p.max_length||255;if(good(v,m))o[p.from]=v});return o}
function write(n,f,vals){var s=f.storage||{},ttl=s.ttl_days||30,p={v:1,funnel_id:f.id,captured_at:new Date().toISOString(),expires_at:Date.now()+ttl*864e5,values:vals},raw=encodeURIComponent(JSON.stringify(p));if(raw.length>3000)return;document.cookie=n+'='+raw+'; expires='+new Date(p.expires_at).toUTCString()+'; path=/; SameSite=Lax; Secure'+domain(s)}
function capture(f,vals){var s=f.storage;if(!s||!s.enabled||!Object.keys(vals).length||!consent())return;var t=s.touch||'last_touch';if((t==='first_touch'||t==='both')&&!cookie(FIRST))write(FIRST,f,vals);if(t==='last_touch'||t==='both')write(LAST,f,vals)}
function stored(f){if(f.source!=='current_or_stored')return{};var s=f.storage||{},x=cookie((s.read_touch||'last_touch')==='first_touch'?FIRST:LAST);return x&&x.funnel_id===f.id&&x.values||{}}
function resolved(f,now){var old=stored(f),o={};f.parameters.forEach(function(p){var m=p.max_length||255,v=now[p.from];if(!good(v,m))v=old[p.from];if(!good(v,m))v=p.fallback;if(good(v,m))o[p.to||p.from]=v});return o}
function page(f){return !f.page_paths||!f.page_paths.length||f.page_paths.indexOf(location.pathname)>=0}
function match(u,t){return u.protocol===(t.protocol||'https:')&&u.hostname.toLowerCase()===t.host.toLowerCase()&&u.pathname===t.path}
function event(a,f,t,vals){if(!t.click_event)return;if(ANALYTICS_CONSENT&&!consent())return;var destination=t.destination||t.host,payload={token:FIRST_PARTY&&FIRST_PARTY.token,event:{name:t.click_event,funnel_id:f.id,destination:destination,path:location.pathname,attribution:vals}};if(FIRST_PARTY&&FIRST_PARTY.endpoint&&FIRST_PARTY.token){var raw=JSON.stringify(payload);try{if(!navigator.sendBeacon||!navigator.sendBeacon(FIRST_PARTY.endpoint,new Blob([raw],{type:'text/plain;charset=UTF-8'})))fetch(FIRST_PARTY.endpoint,{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:raw,keepalive:true,credentials:'omit'}).catch(function(){})}catch(e){}}if(typeof window.gtag==='function')window.gtag('event',t.click_event,{link_url:a.href,link_text:(a.textContent||'').trim().slice(0,200),funnel_id:f.id,destination:destination})}
function init(root){(C.funnels||[]).forEach(function(f){if(!page(f))return;var now=current(f);capture(f,now);var vals=resolved(f,now);(root||document).querySelectorAll('a[href]').forEach(function(a){var u;try{u=new URL(a.getAttribute('href'),location.href)}catch(e){return}var t=f.targets.find(function(x){return x.type==='link'&&match(u,x)});if(!t)return;Object.keys(vals).forEach(function(k){if(f.precedence==='target_over_source'&&u.searchParams.has(k))return;u.searchParams.set(k,vals[k])});a.href=u.toString();if(!bound.has(a)){a.addEventListener('click',function(){event(a,f,t,vals)});bound.add(a)}})})}
window.TyperollFunnels=window.TyperollFunnels||{init:init};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){init(document)},{once:true});else init(document);
document.addEventListener('typeroll:consent',function(e){if(e.detail&&e.detail.choice==='all')init(document);else(C.funnels||[]).forEach(function(f){if(f.storage&&f.storage.enabled){erase(FIRST,f.storage);erase(LAST,f.storage)}})});
})();`;
}

export function asFunnelAttributionConfig(value: unknown): FunnelAttributionConfig | null {
  if (validateFunnelAttributionConfig(value).length > 0) return null;
  return value as FunnelAttributionConfig;
}
