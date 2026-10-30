import { describe, it, expect } from 'vitest';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderCookieConsent } from '../cookie-consent.js';
import { lacksUiTranslation, uiLanguage, uiText } from '../ui-text.js';
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
    expect([lacksUiTranslation('fi'), lacksUiTranslation('nl-NL'), lacksUiTranslation('en-GB'), lacksUiTranslation('')]).toEqual([true, false, false, false]);
    expect(uiText('nl', 'pagination')).toBe('Paginering');
  });

  it('labels archive pagination in the page language', () => {
    expect(pager('nl-NL')).toContain('aria-label="Paginering"');
    expect(pager()).toContain('aria-label="Pagination"');
  });

  it('labels the scrollable table region in the page language', () => {
    expect(table('nl-NL')).toContain('aria-label="Scrollbare tabel"');
    expect(table('de-CH')).toContain('aria-label="Scrollbare Tabelle"');
    expect(table()).toContain('aria-label="Scrollable table"');
  });

  it('gives the cookie banner Dutch defaults, and saved labels still win', () => {
    const dutch = renderCookieConsent({ enabled: true, privacy_policy_url: '/privacy' }, undefined, 'nl-NL')!;
    expect(dutch).toContain('Cookies op deze website');
    expect(dutch).toContain('Alles accepteren');
    const custom = renderCookieConsent({ enabled: true, labels: { accept_all: 'Akkoord' } }, undefined, 'nl')!;
    expect(custom).toContain('>Akkoord<');
    expect(custom).toContain('>Weigeren<');
  });
});
