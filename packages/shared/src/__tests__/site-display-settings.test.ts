import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, contentWidthsError, dateFormatError, defaultSiteSettings, formatDisplayDate, renderBlocks, siteThemeCss, type Block } from '../index.js';

describe('per-site date format and content widths', () => {
  it('validates both settings', () => {
    expect(dateFormatError('long')).toBeNull();
    expect(dateFormatError('D MMMM YYYY')).toBeNull();
    expect(dateFormatError('nonsense')).toMatch(/pattern/);
    expect(contentWidthsError({ normal: 1120 })).toBeNull();
    expect(contentWidthsError({ narrow: 1100, normal: 900 })).toMatch(/≤/);
    expect(contentWidthsError({ huge: 3000 })).toMatch(/narrow, normal or wide/);
  });
  it('formats the presets in the page language', () => {
    expect(formatDisplayDate('2026-10-12', 'sv', 'long')).toBe('12 oktober 2026');
    expect(formatDisplayDate('2026-10-12', 'sv', 'iso')).toBe('2026-10-12');
    expect(formatDisplayDate('2026-10-12', 'en-US', 'numeric')).toBe('10/12/2026');
  });
  it('a page date left at the block default follows the site format', () => {
    const block: Block = { id: 'd', type: 'template/page_date', data: {} };
    const context = { site: { language: 'sv', date_format: 'long' }, page: { language: 'sv', date_published: '2026-10-12' } } as never;
    expect(renderBlocks([block], { registry: buildCoreBlockRegistry(), renderVersion: 14, context })).toContain('>12 oktober 2026</time>');
  });
  it('the theme carries the site content widths from version 14', () => {
    expect(siteThemeCss({ ...defaultSiteSettings, render_version: 14, content_widths: { normal: 1120 } })).toContain('--content-normal:1120px');
    expect(siteThemeCss({ ...defaultSiteSettings, render_version: 14 })).toContain('--content-wide:80rem');
    expect(siteThemeCss({ ...defaultSiteSettings, render_version: 13 })).not.toContain('--content-normal');
  });
});
