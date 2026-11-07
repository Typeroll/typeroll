import { describe, expect, it } from 'vitest';
import { UI_LANGUAGES, buildCoreBlockRegistry, renderBlocks, uiLabel, type Block } from '../index.js';

const registry = buildCoreBlockRegistry();
const render = (block: Block, renderVersion: number, language = 'sv') =>
  renderBlocks([block], { registry, renderVersion, context: { site: { language }, page: { language } } as never });

describe('default labels in the page language', () => {
  it('renders an untouched English default in the page language from version 14', () => {
    const toc: Block = { id: 'toc', type: 'core/table_of_contents', data: { title: 'On this page' } };
    expect(render(toc, 14)).toContain('På den här sidan');
    expect(render(toc, 13)).toContain('On this page');
    const button: Block = { id: 'b', type: 'core/button', data: { href: '/' } };
    expect(render(button, 14, 'de')).toContain('Mehr erfahren');
  });
  it('keeps an authored label', () => {
    const button: Block = { id: 'b', type: 'core/button', data: { label: 'Kontakta oss', href: '/' } };
    expect(render(button, 14)).toContain('Kontakta oss');
  });
  it('has every label in every built-in language', () => {
    for (const language of UI_LANGUAGES) for (const key of ['learn_more', 'menu', 'on_this_page', 'continue', 'home'] as const) {
      expect(uiLabel(language, key)).toBeTruthy();
    }
  });
});

describe('dates in the page language', () => {
  it('formats the default as the language medium date and honours an authored format', async () => {
    const { formatDisplayDate } = await import('../index.js');
    expect(formatDisplayDate('2026-10-12', 'sv')).toBe('12 okt. 2026');
    expect(formatDisplayDate('2026-10-12', 'en')).toBe('Oct 12, 2026');
    expect(formatDisplayDate('2026-10-12', 'sv', 'D MMMM YYYY')).toBe('12 oktober 2026');
    expect(formatDisplayDate('2026-10-12T23:30:00Z', 'de', 'DD.MM.YYYY')).toBe('12.10.2026');
    expect(formatDisplayDate('soon', 'sv')).toBe('soon');
  });
  it('renders a page date in the page language from version 14', () => {
    const block: Block = { id: 'd', type: 'template/page_date', data: {} };
    const context = { site: { language: 'sv' }, page: { language: 'sv', date_published: '2026-10-12' } } as never;
    expect(renderBlocks([block], { registry, renderVersion: 14, context })).toContain('datetime="2026-10-12">12 okt. 2026</time>');
    expect(renderBlocks([block], { registry, renderVersion: 13, context })).toContain('>2026-10-12</time>');
  });
});
