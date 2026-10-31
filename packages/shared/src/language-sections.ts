// Language sections: one site that serves several languages from path
// prefixes, for example Finnish at `/` and Swedish under `/sv/`.
//
// A page belongs to a section through its own `Page.language`. The site's
// main language (`settings.language`) needs no section; its pages keep the
// top-level settings. A section only overrides the few site-wide values that
// are written in a language: the home link, the 404 page, the tagline, the
// fallback meta description and the cookie banner's wording.

import { canonicalTag, isValidHreflangTag } from './hreflang.js';
import { normalizeCookieConsentLabels } from './cookie-consent.js';
import type { CookieConsentLabels, SiteSettings } from './types.js';

export interface LanguageSectionCookieConsent {
  /** HTML body of the banner in this language, sanitized like `cookie_consent.text`. */
  text?: string;
  /** Privacy or cookie policy link for this language, such as `/sv/cookies/`. */
  privacy_policy_url?: string;
  labels?: CookieConsentLabels;
}

export interface LanguageSection {
  /** BCP 47 tag matched against `Page.language`, such as `sv-SE`. */
  language: string;
  /** The section's home page and path prefix, such as `/sv/`. */
  home_path: string;
  tagline?: string;
  default_meta_description?: string;
  cookie_consent?: LanguageSectionCookieConsent;
}

export const MAX_LANGUAGE_SECTIONS = 20;
const SECTION_FIELDS = new Set(['language', 'home_path', 'tagline', 'default_meta_description', 'cookie_consent']);
const CONSENT_FIELDS = new Set(['text', 'privacy_policy_url', 'labels']);
const HOME_PATH_RE = /^\/(?:[a-z0-9][a-z0-9._~-]*\/)+$/i;
const MAX_TEXT = 10_000;
const MAX_SHORT_TEXT = 500;

/** A same-site path or an absolute http(s) URL; never script or data URLs. */
function isPolicyUrl(value: string): boolean {
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function optionalString(value: unknown, field: string, max: number): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const text = value.trim();
  if (text.length > max) return { error: `${field} must be at most ${max} characters` };
  return text ? { value: text } : {};
}

/**
 * Validate and normalize `settings.language_sections` for every write
 * surface. Returns `sections: []` for an empty list, which clears them.
 */
export function normalizeLanguageSections(
  value: unknown,
  siteLanguage?: string,
): { sections?: LanguageSection[]; error?: string } {
  if (value === undefined) return {};
  if (value === null) return { sections: [] };
  if (!Array.isArray(value)) return { error: 'language_sections must be an array' };
  if (value.length > MAX_LANGUAGE_SECTIONS) return { error: `language_sections can hold at most ${MAX_LANGUAGE_SECTIONS} sections` };
  const sections: LanguageSection[] = [];
  const languages = new Set<string>();
  const homes = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const at = `language_sections[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at} must be an object` };
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).filter(key => !SECTION_FIELDS.has(key));
    if (unknown.length) return { error: `Unknown ${at} fields: ${unknown.join(', ')}` };
    if (typeof entry.language !== 'string' || !isValidHreflangTag(entry.language) || entry.language.trim().toLowerCase() === 'x-default') {
      return { error: `${at}.language must be a BCP 47 language tag such as "sv-SE"` };
    }
    const language = canonicalTag(entry.language);
    if (siteLanguage && language.toLowerCase() === canonicalTag(siteLanguage).toLowerCase()) {
      return { error: `${at}.language is the site language; the site's own pages use the top-level settings` };
    }
    if (languages.has(language.toLowerCase())) return { error: `${at}.language repeats ${language}` };
    if (typeof entry.home_path !== 'string' || !HOME_PATH_RE.test(entry.home_path.trim())) {
      return { error: `${at}.home_path must be a path prefix such as "/sv/": it starts and ends with "/" and is not "/"` };
    }
    const homePath = entry.home_path.trim();
    if (homes.has(homePath.toLowerCase())) return { error: `${at}.home_path repeats ${homePath}` };
    const section: LanguageSection = { language, home_path: homePath };
    for (const field of ['tagline', 'default_meta_description'] as const) {
      const checked = optionalString(entry[field], `${at}.${field}`, MAX_SHORT_TEXT);
      if (checked.error) return { error: checked.error };
      if (checked.value) section[field] = checked.value;
    }
    if (entry.cookie_consent !== undefined && entry.cookie_consent !== null) {
      const consent = entry.cookie_consent;
      if (typeof consent !== 'object' || Array.isArray(consent)) return { error: `${at}.cookie_consent must be an object` };
      const fields = consent as Record<string, unknown>;
      const unknownConsent = Object.keys(fields).filter(key => !CONSENT_FIELDS.has(key));
      if (unknownConsent.length) return { error: `Unknown ${at}.cookie_consent fields: ${unknownConsent.join(', ')}` };
      const normalized: LanguageSectionCookieConsent = {};
      const text = optionalString(fields.text, `${at}.cookie_consent.text`, MAX_TEXT);
      if (text.error) return { error: text.error };
      if (text.value) normalized.text = text.value;
      const url = optionalString(fields.privacy_policy_url, `${at}.cookie_consent.privacy_policy_url`, 2048);
      if (url.error) return { error: url.error };
      if (url.value) {
        if (!isPolicyUrl(url.value)) return { error: `${at}.cookie_consent.privacy_policy_url must be a path such as "/sv/cookies/" or an http(s) URL` };
        normalized.privacy_policy_url = url.value;
      }
      const labels = normalizeCookieConsentLabels(fields.labels);
      if (labels.error) return { error: `${at}.${labels.error}` };
      if (labels.labels) normalized.labels = labels.labels;
      if (Object.keys(normalized).length) section.cookie_consent = normalized;
    }
    languages.add(language.toLowerCase());
    homes.add(homePath.toLowerCase());
    sections.push(section);
  }
  return { sections };
}

/** The section a page language belongs to: an exact tag first, then the same primary language. */
export function languageSectionFor(
  sections: readonly LanguageSection[] | undefined,
  language: unknown,
): LanguageSection | undefined {
  if (!sections?.length || typeof language !== 'string' || !language.trim()) return undefined;
  const tag = language.trim().toLowerCase();
  const exact = sections.find(section => section.language.toLowerCase() === tag);
  if (exact) return exact;
  const primary = tag.split('-')[0];
  return sections.find(section => section.language.toLowerCase().split('-')[0] === primary);
}

/** Home page of the page's language: its section's `home_path`, else `/`. */
export function languageHomePath(settings: Pick<SiteSettings, 'language_sections'> | null | undefined, language: unknown): string {
  return languageSectionFor(settings?.language_sections, language)?.home_path ?? '/';
}

/**
 * The settings a page in `language` renders with: its section's tagline,
 * fallback description and cookie-banner wording over the site-wide values.
 * Values a section leaves empty keep the site-wide ones; consent scripts and
 * the enabled switch always stay site-wide.
 */
export function settingsForLanguage<T extends Partial<SiteSettings>>(settings: T, language: unknown): T {
  const section = languageSectionFor(settings.language_sections, language);
  if (!section) return settings;
  const localized: T = { ...settings };
  if (section.tagline) localized.tagline = section.tagline;
  if (section.default_meta_description) localized.default_meta_description = section.default_meta_description;
  if (settings.cookie_consent) {
    const consent = section.cookie_consent ?? {};
    // Site-wide text and labels are written in the site language, so a
    // section without its own falls back to the built-in wording in its
    // language rather than to another language's custom text.
    localized.cookie_consent = {
      ...settings.cookie_consent,
      text: consent.text,
      labels: consent.labels,
      privacy_policy_url: consent.privacy_policy_url ?? settings.cookie_consent.privacy_policy_url,
    };
  }
  return localized;
}
