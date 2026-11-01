import { describe, it, expect } from 'vitest';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderCookieConsent } from '../cookie-consent.js';
import { lacksUiTranslation, languageDirection, uiLanguage, uiText, UI_LANGUAGES } from '../ui-text.js';
import { directionCss, RTL_CSS } from '../rtl-css.js';
import { cookieConsentDefaultText } from '../cookie-consent.js';
import { notFoundText } from '../not-found-text.js';
import { blockUiLanguage } from '../block-media.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();
const items = Array.from({ length: 4 }, (_, i) => ({ title: `Post ${i + 1}`, body: '<p>b</p>' }));
const pager = (language?: string) => renderBlock({ id: 'rep', type: 'core/repeater', data: { source_type: 'pages', content_type: 'blog', item_block: 'core/post_card', paginate: 2 } } as Block, {
  registry, pageSource: () => items, context: { pagination: { current: 1, base_url: '/blog/' }, ...(language ? { page: { language } } : {}) } as any,
});
const table = (language?: string) => renderBlock({ id: 'table', type: 'core/table', data: { rows: [{ cells: [{ html: 'A' }] }] } } as Block, {
  registry, context: (language ? { page: { language } } : {}) as any,
});

describe('built-in interface text', () => {
  it('maps language tags to translated interface languages', () => {
    expect(uiLanguage('nl-NL')).toBe('nl');
    expect(uiLanguage('DE')).toBe('de');
    expect(uiLanguage('svenska')).toBe('en');
    expect(uiLanguage(undefined)).toBe('en');
    expect([lacksUiTranslation('cy'), lacksUiTranslation('nl-NL'), lacksUiTranslation('en-GB'), lacksUiTranslation('')]).toEqual([true, false, false, false]);
    expect(uiText('nl', 'pagination')).toBe('Paginering');
    expect([uiLanguage('nb-NO'), uiLanguage('no'), uiLanguage('nn-NO'), uiLanguage('fi-FI'), uiLanguage('fr-CH'), uiLanguage('pl'), uiLanguage('it-IT'), uiLanguage('es-ES')]).toEqual(['nb', 'nb', 'en', 'fi', 'fr', 'pl', 'it', 'es']);
    expect([lacksUiTranslation('nb-NO'), lacksUiTranslation('nn-NO')]).toEqual([false, true]);
  });

  it('reads script and region for Chinese and the withdrawn Hebrew and Indonesian codes', () => {
    expect(['zh', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh-Hant', 'zh-TW', 'zh-HK', 'zh-Hant-TW', 'zh-Hans-HK', 'ZH-tw'].map(uiLanguage))
      .toEqual(['zh', 'zh', 'zh', 'zh', 'zh-Hant', 'zh-Hant', 'zh-Hant', 'zh-Hant', 'zh', 'zh-Hant']);
    expect([uiLanguage('iw'), uiLanguage('in-ID'), uiLanguage('pt-BR'), uiLanguage('sr-RS'), uiLanguage('ca-ES')]).toEqual(['he', 'id', 'pt', 'sr', 'ca']);
    expect(blockUiLanguage('ja-JP')).toBe('ja');
  });

  it('has its own wording for every built-in language', () => {
    expect(UI_LANGUAGES).toHaveLength(50);
    const english = { text: cookieConsentDefaultText('en'), notFound: notFoundText('en').title, table: uiText('en', 'scrollable_table') };
    for (const language of UI_LANGUAGES.filter(code => code !== 'en')) {
      expect(lacksUiTranslation(language)).toBe(false);
      expect(cookieConsentDefaultText(language)).not.toBe(english.text);
      expect(notFoundText(language).title).not.toBe(english.notFound);
      expect(uiText(language, 'scrollable_table')).not.toBe(english.table);
    }
  });

  it('reads the writing direction from the language and an explicit script', () => {
    expect(['ar', 'ar-EG', 'he', 'iw', 'fa-IR', 'ur-PK', 'ps', 'yi', 'az-Arab', 'pa-Arab'].map(languageDirection)).toEqual(Array(10).fill('rtl'));
    expect(['', undefined, 'en', 'fi', 'sv-SE', 'zh-Hant', 'ku-Latn', 'ar-Latn', 'arn', 'hy'].map(languageDirection)).toEqual(Array(10).fill('ltr'));
  });

  it('mirrors only existing built-in blocks, and only on right-to-left pages', () => {
    expect(directionCss('ltr')).toBe('');
    expect(directionCss('rtl')).toBe(RTL_CSS);
    const ids = new Set([...registry.values()].flatMap(type => [type.id.split('/').pop(), type.name, ...[...String(type.template ?? '').matchAll(/data-block="([^"]+)"/g)].map(match => match[1])]));
    for (const block of RTL_CSS.matchAll(/data-block="([^"]+)"/g)) expect(ids, block[1]).toContain(block[1]);
    for (const rule of RTL_CSS.split('\n').filter(line => !line.startsWith('@media'))) expect(rule.startsWith('[dir="rtl"]'), rule).toBe(true);
  });

  it('labels archive pagination in the page language', () => {
    expect(pager('nl-NL')).toContain('aria-label="Paginering"');
    expect(pager()).toContain('aria-label="Pagination"');
  });

  it('labels the scrollable table region in the page language', () => {
    expect(table('nl-NL')).toContain('aria-label="Scrollbare tabel"');
    expect(table('de-CH')).toContain('aria-label="Scrollbare Tabelle"');
    expect(table()).toContain('aria-label="Scrollable table"');
    expect(table('nb-NO')).toContain('aria-label="Rullbar tabell"');
    expect(pager('nb-NO')).toContain('aria-label="Sidenavigasjon"');
  });

  it('gives the cookie banner Dutch defaults, and saved labels still win', () => {
    const dutch = renderCookieConsent({ enabled: true, privacy_policy_url: '/privacy' }, undefined, 'nl-NL')!;
    expect(dutch).toContain('Cookies op deze website');
    expect(dutch).toContain('Alles accepteren');
    const custom = renderCookieConsent({ enabled: true, labels: { accept_all: 'Akkoord' } }, undefined, 'nl')!;
    expect(custom).toContain('>Akkoord<');
    expect(custom).toContain('>Weigeren<');
  });

  it('gives the cookie banner Norwegian defaults and a configurable manage button text', () => {
    const norwegian = renderCookieConsent({ enabled: true, privacy_policy_url: '/personvern' }, undefined, 'nb-NO')!;
    for (const text of ['Informasjonskapsler på dette nettstedet', '>Avslå<', '>Bare nødvendige<', '>Godta alle<', 'aria-label="Administrer innstillinger for informasjonskapsler"', '<span>Cookies</span>']) expect(norwegian).toContain(text);
    const custom = renderCookieConsent({ enabled: true, labels: { manage_button: 'Informasjonskapsler <b>' } }, undefined, 'nb-NO')!;
    expect(custom).toContain('<span>Informasjonskapsler &lt;b&gt;</span>');
  });
});
