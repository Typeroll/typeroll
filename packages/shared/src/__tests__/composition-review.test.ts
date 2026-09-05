import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { reviewBlockComposition } from '../composition-review.js';
import type { BlockType } from '../types.js';

describe('reviewBlockComposition', () => {
  it('reports the native requirements of a ready composition', () => {
    const review = reviewBlockComposition({
      name: 'Article',
      fields: [{ name: 'body' }, { name: 'pdf_url' }],
      blocks: [
        { id: 'body', type: 'template/item_body', data: { field: 'body' } },
        { id: 'pdf', type: 'core/button', data: { label: 'PDF', href: '{{item.pdf_url}}' } },
      ],
    }, buildCoreBlockRegistry());

    expect(review.status).toBe('ready');
    expect(review.required_item_fields).toEqual(['body', 'pdf_url']);
    expect(review.required_block_types).toEqual(['core/button', 'template/item_body']);
    expect(review.missing_item_fields).toEqual([]);
    expect(review.required_capabilities).toContain('supports_typed_context_bindings');
    expect(review.requires_hosted_verification).toBe(true);
    expect(review.workarounds).toEqual([]);
  });

  it('waits when block types or declared item fields are missing', () => {
    const review = reviewBlockComposition({
      id: 'checklist',
      name: 'Checklist',
      fields: [{ name: 'title' }],
      blocks: [
        { id: 'body', type: 'template/item_body', data: { field: 'body' } },
        { id: 'special', type: 'site/download_card', data: {} },
      ],
    }, buildCoreBlockRegistry());

    expect(review.status).toBe('waiting_for_native_support');
    expect(review.missing_block_types).toEqual(['site/download_card']);
    expect(review.missing_item_fields).toEqual(['body']);
  });

  it('allows declared business-specific blocks but flags generic custom replacements', () => {
    const registry = buildCoreBlockRegistry();
    const custom: BlockType = {
      id: 'site/download_card',
      name: 'download_card',
      label: 'Download card',
      category: 'custom',
      container: false,
      schema: [],
      template: '<a>Download</a>',
      origin: 'user',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    registry.set(custom.id, custom);

    const generic = reviewBlockComposition({
      name: 'Generic download',
      blocks: [{ id: 'special', type: custom.id, data: {} }],
    }, registry);
    expect(generic.status).toBe('waiting_for_native_support');
    expect(generic.generic_custom_block_types).toEqual([custom.id]);

    const specific = reviewBlockComposition({
      name: 'Business calculator',
      business_specific_block_types: [custom.id],
      blocks: [{ id: 'special', type: custom.id, data: {} }],
    }, registry);
    expect(specific.status).toBe('ready');
    expect(specific.business_specific_block_types).toEqual([custom.id]);
  });

  it('flags raw HTML and per-instance CSS as workaround debt', () => {
    const review = reviewBlockComposition({
      name: 'Bespoke article',
      blocks: [
        { id: 'html', type: 'core/html', data: { html: '<article></article>' } },
        {
          id: 'heading',
          type: 'core/heading',
          data: { text: 'Title' },
          style_overrides: { custom_css: '.title { color: red }' },
        },
      ],
    }, buildCoreBlockRegistry());

    expect(review.status).toBe('waiting_for_native_support');
    expect(review.workarounds.map((item) => item.kind)).toEqual(['raw_html', 'custom_css']);
  });
});
