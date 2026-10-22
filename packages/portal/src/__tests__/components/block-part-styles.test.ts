// Block parts in the portal: the inspector's `part_styles` pickers
// (FieldInput) and the style library's site-wide "Block parts" picker.

import { describe, expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PART_STYLES_FIELD_DEFINITION, defaultBreakpointWidths, type BlockType, type SiteStyle } from '@typeroll/shared';
import FieldInput, { EditedBlockTypeContext, RenderVersionContext, SiteStylesContext, setPartStyle, stylableParts } from '../../components/FieldInput';
import StyleLibrary, { blockPartChoices, draftPartErrors, togglePart, type BlockPartChoice } from '../../components/StyleLibrary';

const type: Pick<BlockType, 'id' | 'parts'> = {
  id: 'site/teaser',
  parts: [
    { name: 'link', label: 'Links', selector: 'a', target: 'link' },
    { name: 'media', label: 'Image', selector: 'img', target: 'image', min_render_version: 99 },
    { name: 'title', label: 'Title', selector: 'h2', target: 'heading', style_field: 'title_style_id' },
  ],
};

const styles: SiteStyle[] = [
  { id: 'quiet-link', name: 'Quiet link', targets: ['link'], base: { decoration: 'none' }, parts: ['site/teaser.link'] },
  { id: 'loud-link', name: 'Loud link', targets: ['link'], base: { weight: 700 } },
  { id: 'lead', name: 'Lead', targets: ['text'], base: {} },
];

function renderField(value: unknown, renderVersion: number | null, edited: Pick<BlockType, 'id' | 'parts'> | null = type): string {
  const field = createElement(FieldInput, { siteId: 'site-1', field: PART_STYLES_FIELD_DEFINITION, value, onChange: () => {} });
  const wrap = (node: ReactNode) => createElement(SiteStylesContext.Provider, { value: styles },
    createElement(RenderVersionContext.Provider, { value: renderVersion },
      createElement(EditedBlockTypeContext.Provider, { value: edited }, node)));
  return renderToStaticMarkup(wrap(field));
}

describe('part_styles field', () => {
  it('lists the parts an instance may style at the render version', () => {
    expect(stylableParts(type, 1).map(part => part.name)).toEqual(['link']);
    expect(stylableParts(type, null).map(part => part.name)).toEqual(['link', 'media']);
  });

  it('keeps only stylable parts and drops the map when every part is the site default', () => {
    const parts = ['link', 'media'];
    expect(setPartStyle(undefined, 'link', 'loud-link', parts)).toEqual({ link: 'loud-link' });
    expect(setPartStyle({ link: 'loud-link', gone: 'x' }, 'media', 'frame', parts)).toEqual({ link: 'loud-link', media: 'frame' });
    expect(setPartStyle({ link: 'loud-link' }, 'link', '', parts)).toBeUndefined();
    expect(setPartStyle({ link: 'loud-link' }, 'title', 'lead', parts)).toEqual({ link: 'loud-link' });
  });

  it('renders one style picker per part with the styles that fit it', () => {
    const html = renderField({ link: 'loud-link' }, 1);
    expect(html).toContain('<legend');
    expect(html).toContain('>Links</label>');
    expect(html).not.toContain('>Image</label>');
    expect(html).not.toContain('>Title</label>');
    expect(html).toContain('Site default (Quiet link)');
    expect(html).toMatch(/<option value="loud-link" selected="">Loud link<\/option>/);
    expect(html).not.toContain('>Lead<');
    expect(html).toContain('href="/app/sites/site-1/styles"');
    expect(html).not.toContain('type="text"');
  });

  it('shows an unknown stored style as missing', () => {
    expect(renderField({ link: 'deleted-style' }, 1)).toContain('deleted-style (missing style)');
  });

  it('renders nothing without a block type, never a text input', () => {
    expect(renderField(undefined, 1, null)).toBe('');
    expect(renderField(undefined, 1, { id: 'site/plain', parts: [] })).toBe('');
  });
});

describe('style library block parts', () => {
  const registry = new Map<string, BlockType>([
    ['site/teaser', { ...type, name: 'teaser', label: 'Teaser', category: 'content', container: false, schema: [], template: '' } as unknown as BlockType],
    ['core/alpha', { id: 'core/alpha', name: 'alpha', label: 'Alpha', category: 'content', container: false, schema: [], template: '', parts: [{ name: 'body', label: 'Body', selector: 'p', target: 'text' }] } as unknown as BlockType],
  ]);
  const choices: BlockPartChoice[] = blockPartChoices(registry);

  it('lists every declared part, grouped by block label', () => {
    expect(choices.map(choice => choice.ref)).toEqual(['core/alpha.body', 'site/teaser.link', 'site/teaser.media', 'site/teaser.title']);
    expect(choices[1]).toEqual({ ref: 'site/teaser.link', blockLabel: 'Teaser', partLabel: 'Links', target: 'link' });
  });

  it('toggles part references', () => {
    expect(togglePart(undefined, 'site/teaser.link', true)).toEqual(['site/teaser.link']);
    expect(togglePart(['site/teaser.link'], 'site/teaser.link', true)).toEqual(['site/teaser.link']);
    expect(togglePart(['site/teaser.link'], 'site/teaser.link', false)).toBeUndefined();
  });

  it('reports parts of another kind, unknown parts and a part another style applies to', () => {
    const draft: SiteStyle = { id: 'loud-link', name: 'Loud link', targets: ['link'], base: {}, parts: ['site/teaser.link', 'core/alpha.body', 'core/nope.x'] };
    const errors = draftPartErrors(draft, styles, choices, false);
    expect(errors.some(error => error.includes('Alpha · Body takes text styles'))).toBe(true);
    expect(errors.some(error => error.includes('core/nope.x is not a block part'))).toBe(true);
    expect(errors.some(error => error.includes('"quiet-link" and "loud-link"'))).toBe(true);
    expect(draftPartErrors({ ...draft, parts: ['site/teaser.link'], id: 'quiet-link' }, styles, choices, false)).toEqual([]);
  });

  it('renders the new targets, properties and the block parts picker', () => {
    const html = renderToStaticMarkup(createElement(StyleLibrary, {
      siteId: 'site-1', initialStyles: styles, colors: {}, breakpoints: defaultBreakpointWidths,
      renderVersion: 1, baseCss: '', canEdit: true, blockParts: choices,
    }));
    expect(html).toContain('Links</label>');
    expect(html).toContain('Images</label>');
    expect(html).toContain('aria-label="Opacity"');
    expect(html).toContain('aria-label="Shadow"');
    expect(html).toContain('aria-label="Gap between items"');
    expect(html).toContain('Block parts</legend>');
    expect(html).toContain('Teaser</legend>');
    // The first style targets links: text parts are not offered.
    expect(html).not.toContain('Alpha</legend>');
  });
});
