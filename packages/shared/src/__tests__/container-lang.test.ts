import { describe, expect, it } from 'vitest';
import { LATEST_RENDER_VERSION, blockTreeError, buildCoreBlockRegistry, contentLanguageTag, renderBlock } from '../index.js';

const registry = buildCoreBlockRegistry();
const render = (data: Record<string, unknown>, pageLanguage = 'nl-BE', renderVersion = LATEST_RENDER_VERSION) => renderBlock({
  id: 'fr', type: 'core/container', data,
  children: [
    { id: 'h', type: 'core/heading', data: { text: 'Je déménage à l’étranger', level: 'h2' } },
    { id: 'b', type: 'core/button', data: { label: 'JE DÉMÉNAGE', href: '/fr/' } },
    { id: 'i', type: 'core/image', data: { src: '/m.jpg', alt: 'Un camion de déménagement' } },
  ],
} as never, { registry, renderVersion, context: { page: { language: pageLanguage } } as never });
const openingTag = (html: string) => html.match(/<div[^>]*data-block="(?:semantic-)?container"[^>]*>/)![0];

describe('core/container lang', () => {
  it('declares an optional language field', () => {
    const field = registry.get('core/container')!.schema!.find(f => f.name === 'lang');
    expect(field).toMatchObject({ type: 'text', label: 'Language of this part', editor_group: 'content' });
    expect(field!.required).toBeFalsy();
  });

  it('marks the part so every heading, button and image alt inside is in that language', () => {
    const html = render({ lang: 'fr-be' });
    expect(openingTag(html)).toContain('lang="fr-BE"');
    expect(openingTag(html)).not.toContain('dir=');
    // One element carries the language; the children inherit it.
    expect(html.match(/ lang="/g)).toHaveLength(1);
    expect(html.indexOf('lang="fr-BE"')).toBeLessThan(html.indexOf('JE DÉMÉNAGE'));
    expect(html.indexOf('Un camion')).toBeLessThan(html.lastIndexOf('</div>'));
    expect(openingTag(render({ lang: 'fr-BE', layout: 'flow' }))).toContain('lang="fr-BE"');
  });

  it('renders byte-identical output without the field, on every render version', () => {
    for (let version = 1; version <= LATEST_RENDER_VERSION; version++) {
      const plain = render({ width: 'wide' }, 'nl-BE', version);
      expect(render({ width: 'wide', lang: '' }, 'nl-BE', version)).toBe(plain);
      expect(render({ width: 'wide', lang: '  ' }, 'nl-BE', version)).toBe(plain);
      expect(plain).not.toMatch(/ (?:lang|dir)="/);
    }
  });

  it('sets dir for a right-to-left part and for a left-to-right part on a right-to-left page', () => {
    expect(openingTag(render({ lang: 'ar' }))).toContain('lang="ar" dir="rtl"');
    expect(openingTag(render({ lang: 'fr-BE' }, 'ar'))).toContain('lang="fr-BE" dir="ltr"');
    expect(openingTag(render({ lang: 'he' }, 'ar'))).toContain('lang="he" dir="rtl"');
    expect(openingTag(render({ lang: 'az-Arab' }))).toContain('dir="rtl"');
  });

  it('wins over a lang attribute and keeps an authored dir', () => {
    const tag = openingTag(render({ lang: 'fr-BE', attributes: [{ name: 'lang', value: 'de' }, { name: 'dir', value: 'auto' }, { name: 'data-part', value: 'fr' }] }, 'ar'));
    expect(tag).toContain('lang="fr-BE" dir="auto" data-part="fr"');
    expect(tag).not.toContain('lang="de"');
    // Without the field the attributes render exactly as before.
    expect(openingTag(render({ attributes: [{ name: 'lang', value: 'de' }] }))).toContain('lang="de"');
  });

  it('ignores an invalid tag at render and rejects it at write', () => {
    expect(render({ lang: 'fr" onclick="x' })).toBe(render({}));
    expect(contentLanguageTag('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(contentLanguageTag('x-default')).toBe('');
    expect(blockTreeError([{ type: 'core/container', data: { lang: 'fr-BE' } }])).toBeNull();
    expect(blockTreeError([{ type: 'core/container', data: { lang: '' } }])).toBeNull();
    expect(blockTreeError([{ type: 'core/section', data: {}, children: [{ type: 'core/container', data: { lang: 'French' } }] }]))
      .toBe('blocks[0].children[0].data.lang must be a BCP 47 language tag such as "fr-BE", or empty to use the page language.');
    expect(blockTreeError([{ type: 'core/container', data: { lang: 7 } }])).toContain('data.lang');
  });
});
