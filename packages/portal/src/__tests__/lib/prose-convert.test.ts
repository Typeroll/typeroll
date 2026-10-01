import { describe, it, expect } from 'vitest';
import type { Block } from '@typeroll/shared';
import { applyProseConversion, previewProseConversion, ProseConvertError } from '../../lib/prose-convert';

const tree = (): Block[] => [
  { id: 'hero', type: 'core/section', data: {}, children: [
    { id: 'text', type: 'core/prose', data: { html: '<p class="eyebrow">For leaders</p><h2>Plan</h2><p>Body</p><ul><li>One</li></ul>' }, style_overrides: { html_id: 'intro' }, hidden_on: ['mobile'] },
  ] },
  { id: 'heading', type: 'core/heading', data: { text: 'Other' } },
];

describe('prose conversion', () => {
  it('previews the blocks a text block becomes without changing the tree', () => {
    const original = tree();
    const preview = previewProseConversion(original, 'text');
    expect(preview.converted.map(block => block.type)).toEqual(['core/heading', 'core/prose', 'core/list']);
    expect(preview.converted[0].data).toMatchObject({ text: 'Plan', eyebrow: 'For leaders' });
    expect(preview.converted[0].style_overrides).toEqual({ html_id: 'intro' });
    expect(preview.converted.every(block => block.hidden_on?.[0] === 'mobile')).toBe(true);
    expect(original[0].children?.[0].type).toBe('core/prose');
  });

  it('replaces the block only with a matching preview fingerprint', () => {
    const preview = previewProseConversion(tree(), 'text');
    expect(() => applyProseConversion(tree(), 'text', 'stale')).toThrow(ProseConvertError);
    const { blocks } = applyProseConversion(tree(), 'text', preview.fingerprint);
    expect(blocks[0].children?.map(block => block.type)).toEqual(['core/heading', 'core/prose', 'core/list']);
    expect(blocks[1].id).toBe('heading');
  });

  it('refuses blocks that are not text blocks', () => {
    expect(() => previewProseConversion(tree(), 'heading')).toThrow(/Only text blocks/);
    expect(() => previewProseConversion(tree(), 'missing')).toThrow(/not found/);
  });
});
