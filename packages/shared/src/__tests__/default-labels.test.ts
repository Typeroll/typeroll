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
