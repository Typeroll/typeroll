import type { CookieConsentLabels, CookieConsentSettings } from './types.js';
import { buildConsentRuntime, wrapConsentScripts } from './consent-scripts.js';
import { uiLanguage, type UiLanguage } from './ui-text.js';

/** Swedish default body text, kept for callers that predate localization. */
export const DEFAULT_COOKIE_CONSENT_TEXT =
  'Vi använder cookies för att webbplatsen ska fungera och för att förstå hur den används. Du kan välja att godkänna alla cookies, bara de nödvändiga, eller neka.';

export type CookieConsentLanguage = UiLanguage;

type ConsentStrings = Required<CookieConsentLabels> & { text: string };

const CONSENT_STRINGS: Record<CookieConsentLanguage, ConsentStrings> = {
  sv: {
    text: DEFAULT_COOKIE_CONSENT_TEXT,
    title: 'Cookies på den här webbplatsen',
    reject: 'Neka',
    necessary: 'Endast nödvändiga',
    accept_all: 'Godkänn alla',
    privacy_link: 'Läs vår integritetspolicy →',
    manage: 'Hantera cookie-inställningar',
  },
  de: {
    text: 'Wir verwenden Cookies, damit die Website funktioniert und um zu verstehen, wie sie genutzt wird. Sie können alle Cookies akzeptieren, nur die notwendigen zulassen oder ablehnen.',
    title: 'Cookies auf dieser Website',
    reject: 'Ablehnen',
    necessary: 'Nur notwendige',
    accept_all: 'Alle akzeptieren',
    privacy_link: 'Datenschutzerklärung lesen →',
    manage: 'Cookie-Einstellungen verwalten',
  },
  nl: {
    text: 'We gebruiken cookies om deze website te laten werken en om te begrijpen hoe die wordt gebruikt. Je kunt alle cookies accepteren, alleen de noodzakelijke toestaan of weigeren.',
    title: 'Cookies op deze website',
    reject: 'Weigeren',
    necessary: 'Alleen noodzakelijke',
    accept_all: 'Alles accepteren',
    privacy_link: 'Lees ons privacybeleid →',
    manage: 'Cookie-instellingen beheren',
  },
  en: {
    text: 'We use cookies to make this website work and to understand how it is used. You can accept all cookies, allow only the necessary ones, or decline.',
    title: 'Cookies on this website',
    reject: 'Decline',
    necessary: 'Necessary only',
    accept_all: 'Accept all',
    privacy_link: 'Read our privacy policy →',
    manage: 'Manage cookie settings',
  },
};

/** Built-in banner language for a BCP 47 tag: Swedish, German, Dutch, otherwise English. */
export function cookieConsentLanguage(language: unknown): CookieConsentLanguage {
  return uiLanguage(language);
}

/** Default body text shown when the site has not written its own. */
export function cookieConsentDefaultText(language: unknown): string {
  return CONSENT_STRINGS[cookieConsentLanguage(language)].text;
}

export const COOKIE_CONSENT_LABEL_KEYS = [
  'title', 'reject', 'necessary', 'accept_all', 'privacy_link', 'manage',
] as const;
export const COOKIE_CONSENT_LABEL_MAX_LENGTH = 120;

/**
 * Validate cookie_consent.labels from an API or form write. Values are plain
 * text; blank values are dropped so the built-in wording applies.
 */
export function normalizeCookieConsentLabels(value: unknown): { labels?: CookieConsentLabels; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'cookie_consent.labels must be an object' };
  const allowed = new Set<string>(COOKIE_CONSENT_LABEL_KEYS);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `Unknown cookie_consent.labels fields: ${unknown.join(', ')}` };
  const labels: CookieConsentLabels = {};
  for (const key of COOKIE_CONSENT_LABEL_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { error: `cookie_consent.labels.${key} must be a string` };
    const text = raw.trim();
    if (text.length > COOKIE_CONSENT_LABEL_MAX_LENGTH) {
      return { error: `cookie_consent.labels.${key} must be at most ${COOKIE_CONSENT_LABEL_MAX_LENGTH} characters` };
    }
    if (text) labels[key] = text;
  }
  return Object.keys(labels).length ? { labels } : {};
}

function consentLabels(consent: CookieConsentSettings, language: unknown): ConsentStrings {
  const defaults = CONSENT_STRINGS[cookieConsentLanguage(language)];
  const custom = consent.labels ?? {};
  const pick = (key: keyof CookieConsentLabels) => {
    const value = custom[key];
    return typeof value === 'string' && value.trim() ? value.trim() : defaults[key];
  };
  return {
    text: defaults.text,
    title: pick('title'),
    reject: pick('reject'),
    necessary: pick('necessary'),
    accept_all: pick('accept_all'),
    privacy_link: pick('privacy_link'),
    manage: pick('manage'),
  };
}

export const COOKIE_CONSENT_STYLES = `
.tr-consent{display:none;position:fixed;inset:0;z-index:2147483000;align-items:flex-end;justify-content:center;font-family:var(--font-body),-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter',sans-serif}
.tr-consent-needed .tr-consent{display:flex;animation:tr-cc-fade .3s ease-out}
.tr-consent-needed{overflow:hidden}
.tr-consent-needed body{overflow:hidden}
.tr-consent__backdrop{position:absolute;inset:0;background:rgba(15,23,42,.32);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%)}
.tr-consent__panel{position:relative;width:100%;max-width:480px;background:rgba(255,255,255,.82);-webkit-backdrop-filter:blur(40px) saturate(200%);backdrop-filter:blur(40px) saturate(200%);border:1px solid rgba(255,255,255,.5);border-radius:24px 24px 0 0;padding:1.75rem 1.5rem calc(1.5rem + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 40px rgba(0,0,0,.18),0 1px 0 rgba(255,255,255,.45) inset;animation:tr-cc-rise .4s cubic-bezier(.16,1,.3,1)}
@media (min-width:640px){.tr-consent{align-items:center;padding:1.25rem}.tr-consent__panel{border-radius:24px;padding:2rem;animation:tr-cc-pop .35s cubic-bezier(.16,1,.3,1)}}
.tr-consent__title{font-family:var(--font-heading),sans-serif;font-size:1.25rem;font-weight:600;line-height:1.25;letter-spacing:-.01em;color:#0f172a;margin:0 0 .75rem}
.tr-consent__body{color:#334155;font-size:.9375rem;line-height:1.55;margin:0 0 1.25rem}
.tr-consent__body p{margin:0 0 .5rem}.tr-consent__body p:last-child{margin-bottom:0}
.tr-consent__body a{color:var(--color-primary);text-decoration:underline;text-underline-offset:2px}
.tr-consent__link{display:inline-block;margin:-.5rem 0 1.25rem;color:var(--color-primary);font-size:.875rem;text-decoration:underline;text-underline-offset:2px}
.tr-consent__actions{display:grid;grid-template-columns:1fr;gap:.625rem}
@media (min-width:520px){.tr-consent__actions{grid-template-columns:1fr 1fr 1.3fr}}
.tr-consent__btn{appearance:none;border:0;font:600 .9375rem/1.2 inherit;padding:.95rem 1rem;border-radius:14px;cursor:pointer;min-height:48px;transition:transform .15s ease,box-shadow .2s ease,background-color .2s ease;letter-spacing:.01em;-webkit-tap-highlight-color:transparent}
.tr-consent__btn:active{transform:scale(.97)}
.tr-consent__btn:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
.tr-consent__btn--ghost{background:rgba(15,23,42,.05);color:#475569}
.tr-consent__btn--ghost:hover{background:rgba(15,23,42,.09)}
.tr-consent__btn--secondary{background:rgba(255,255,255,.7);color:#0f172a;border:1px solid rgba(15,23,42,.1);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.tr-consent__btn--secondary:hover{background:#fff}
.tr-consent__btn--primary{background:var(--color-primary);background-image:linear-gradient(180deg,color-mix(in srgb,var(--color-primary) 88%,white) 0%,var(--color-primary) 100%);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08),0 6px 18px color-mix(in srgb,var(--color-primary) 32%,transparent)}
.tr-consent__btn--primary:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(0,0,0,.1),0 10px 26px color-mix(in srgb,var(--color-primary) 42%,transparent)}
.tr-consent__handle{display:block;width:36px;height:5px;border-radius:999px;background:rgba(15,23,42,.18);margin:-.5rem auto 1rem}
@media (min-width:640px){.tr-consent__handle{display:none}}
.tr-consent__manage{appearance:none;border:0;cursor:pointer;position:fixed;bottom:1rem;left:1rem;z-index:2147482999;display:inline-flex;align-items:center;gap:.4rem;background:rgba(15,23,42,.72);color:#fff;font:500 .75rem/1 -apple-system,BlinkMacSystemFont,'SF Pro Display','Inter',sans-serif;padding:.5rem .8rem;border-radius:999px;text-decoration:none;-webkit-backdrop-filter:blur(12px) saturate(160%);backdrop-filter:blur(12px) saturate(160%);box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:.78;transition:opacity .2s ease,transform .15s ease;padding-bottom:calc(.5rem + env(safe-area-inset-bottom,0px))}
.tr-consent__manage:hover{opacity:1;transform:translateY(-1px)}
.tr-consent__manage:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
.tr-consent__manage svg{width:14px;height:14px}
.tr-consent-needed .tr-consent__manage{display:none}
@keyframes tr-cc-fade{from{opacity:0}to{opacity:1}}
@keyframes tr-cc-rise{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes tr-cc-pop{from{transform:scale(.96);opacity:0}to{transform:scale(1);opacity:1}}
@media (prefers-color-scheme:dark){
  .tr-consent__panel{background:rgba(28,28,32,.82);border-color:rgba(255,255,255,.08);box-shadow:0 -10px 40px rgba(0,0,0,.4),0 1px 0 rgba(255,255,255,.06) inset}
  .tr-consent__title{color:#f8fafc}
  .tr-consent__body{color:#cbd5e1}
  .tr-consent__btn--ghost{background:rgba(255,255,255,.06);color:#cbd5e1}
  .tr-consent__btn--ghost:hover{background:rgba(255,255,255,.12)}
  .tr-consent__btn--secondary{background:rgba(255,255,255,.08);color:#f8fafc;border-color:rgba(255,255,255,.12)}
  .tr-consent__btn--secondary:hover{background:rgba(255,255,255,.14)}
  .tr-consent__handle{background:rgba(255,255,255,.2)}
}
@media (prefers-reduced-motion:reduce){.tr-consent,.tr-consent__panel{animation:none!important}.tr-consent__btn{transition:none}}
`;

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const escapeText = escapeAttr;

/**
 * Render the complete consent fragment shared by static output and the
 * isolated hosted preview. bodyHtml must already have passed the caller's
 * HTML sanitizer because allowed iframe hosts are site-specific. language is
 * the page's BCP 47 tag; it selects the built-in wording, which
 * consent.labels can replace per site.
 */
export function renderCookieConsent(
  consent: CookieConsentSettings | undefined,
  bodyHtml?: string,
  language?: string,
  options: { initialChoice?: 'all' | 'necessary' } = {},
): string {
  if (consent?.enabled !== true) return '';
  const labels = consentLabels(consent, language);
  const body = bodyHtml || `<p>${escapeText(labels.text)}</p>`;
  const necessary = consent.scripts_necessary ?? '';
  const optional = consent.scripts_optional
    ? wrapConsentScripts(consent.scripts_optional)
    : '';
  const privacyLink = consent.privacy_policy_url
    ? `<a class="tr-consent__link" href="${escapeAttr(consent.privacy_policy_url)}" target="_blank" rel="noopener">${escapeText(labels.privacy_link)}</a>`
    : '';

  return `${necessary}${optional}<style data-cookie-consent="1">${COOKIE_CONSENT_STYLES}</style>
<div id="tr-consent" class="tr-consent" role="dialog" aria-modal="true" aria-labelledby="tr-consent-title" aria-describedby="tr-consent-body">
  <div class="tr-consent__backdrop" aria-hidden="true"></div>
  <div class="tr-consent__panel">
    <span class="tr-consent__handle" aria-hidden="true"></span>
    <h2 id="tr-consent-title" class="tr-consent__title">${escapeText(labels.title)}</h2>
    <div id="tr-consent-body" class="tr-consent__body">${body}</div>
    ${privacyLink}
    <div class="tr-consent__actions">
      <button type="button" class="tr-consent__btn tr-consent__btn--ghost" data-tr-consent-action="rejected">${escapeText(labels.reject)}</button>
      <button type="button" class="tr-consent__btn tr-consent__btn--ghost" data-tr-consent-action="necessary">${escapeText(labels.necessary)}</button>
      <button type="button" class="tr-consent__btn tr-consent__btn--primary" data-tr-consent-action="all">${escapeText(labels.accept_all)}</button>
    </div>
  </div>
</div>
<button type="button" class="tr-consent__manage" data-tr-open-consent aria-label="${escapeAttr(labels.manage)}">
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.5" r=".9" fill="currentColor"/><circle cx="10.5" cy="7.5" r=".7" fill="currentColor"/><circle cx="7" cy="10.5" r=".8" fill="currentColor"/></svg>
  <span>Cookies</span>
</button>
<script data-cookie-consent-runtime="1">${buildConsentRuntime(consent.reload_after_consent === true, options.initialChoice)}</script>`;
}
