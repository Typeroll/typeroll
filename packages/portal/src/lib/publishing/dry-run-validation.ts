// @ts-ignore -- the validator is plain JavaScript shared with the frozen publication build.
import { unnamedImageLinks } from '../../../../site-template/src/lib/publication-validation.mjs';
import { COOKIE_CONSENT_LABEL_KEYS, lacksUiTranslation } from '@typeroll/shared';
import { ConnectionError } from './connections';

export interface DryRunValidationIssue { code: 'image_link_unnamed'; page: string; href: string; source: 'image_block' | 'html' }

/**
 * Checks a dry run can make on frozen content without rendering. They mirror
 * build rules that otherwise fail only after media preparation; the full
 * validator still runs on the rendered output.
 */
export function dryRunValidationIssues(pages: Array<Record<string, any>>): DryRunValidationIssue[] {
  const issues: DryRunValidationIssue[] = [];
  for (const page of pages) {
    const label = String(page.path ?? page.url ?? page.id ?? '');
    const seen = new Set<unknown>();
    const visit = (value: unknown): void => {
      if (!value || seen.has(value)) return;
      if (typeof value === 'string') {
        if (/<a[\s>]/i.test(value) && /<img[\s>]/i.test(value)) for (const href of unnamedImageLinks(value)) issues.push({ code: 'image_link_unnamed', page: label, href, source: 'html' });
        return;
      }
      if (typeof value !== 'object') return;
      seen.add(value);
      const block = value as Record<string, any>;
      if (block.type === 'core/image' && block.data && typeof block.data === 'object') {
        const link = String(block.data.link ?? '').trim();
        if (link && !String(block.data.alt ?? '').trim()) issues.push({ code: 'image_link_unnamed', page: label, href: link, source: 'image_block' });
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    };
    visit(page);
  }
  return issues;
}

export function assertDryRunValidation(pages: Array<Record<string, any>>) {
  const issues = dryRunValidationIssues(pages);
  if (!issues.length) return;
  const first = issues[0];
  throw new ConnectionError(`Publication validation failed: Image link has no accessible name: ${first.href} (${first.page})${issues.length > 1 ? ` and ${issues.length - 1} more` : ''}. Supply meaningful image alt text or link text.`, 422, 'publication_validation_failed', { issues: issues.slice(0, 50) });
}

/**
 * Built-in wording that falls back to English because Typeroll has no
 * translation for a language the publication uses. Non-blocking: the job
 * reports it so the site can supply its own banner wording.
 */
export function publicationLanguageWarnings(publication: { settings?: Record<string, any>; pages?: Array<Record<string, any>> }): string[] {
  const languages = new Set([publication.settings?.language, ...(publication.pages ?? []).map(page => page.language)]
    .filter((language): language is string => typeof language === 'string' && Boolean(language.trim())).map(language => language.trim()));
  const consent = publication.settings?.cookie_consent;
  const warnings: string[] = [];
  for (const language of languages) {
    if (!lacksUiTranslation(language)) continue;
    warnings.push(`Typeroll has no built-in ${language} interface text, so ${language} pages use English for the labels of archive pagination, scrollable tables, carousels, videos and tabs.`);
    if (consent?.enabled !== true) continue;
    const missing = [
      ...(String(consent.text ?? '').trim() ? [] : ['cookie_consent.text']),
      ...COOKIE_CONSENT_LABEL_KEYS.filter(key => !String(consent.labels?.[key] ?? '').trim()).map(key => `cookie_consent.labels.${key}`),
    ];
    if (missing.length) warnings.push(`The cookie banner shows English on ${language} pages for ${missing.join(', ')}. Save ${language} wording for them in the site settings.`);
  }
  return warnings;
}
