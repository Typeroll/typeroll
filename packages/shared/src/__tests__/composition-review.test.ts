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
        { id: 'body', type: 'template_content_slot', data: {} },
        { id: 'pdf', type: 'core/button', data: { label: 'PDF', href: '{{page.pdf_url}}' } },
      ],
    }, buildCoreBlockRegistry());

    expect(review.status).toBe('ready');
    expect(review.required_fields).toEqual(['pdf_url']);
    expect(review.required_block_types).toEqual(['core/button', 'template_content_slot']);
    expect(review.missing_fields).toEqual([]);
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
        { id: 'body', type: 'core/prose', data: { html: '{{page.introduction}}' } },
        { id: 'special', type: 'site/download_card', data: {} },
      ],
    }, buildCoreBlockRegistry());

    expect(review.status).toBe('waiting_for_native_support');
    expect(review.missing_block_types).toEqual(['site/download_card']);
    expect(review.missing_fields).toEqual(['introduction']);
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

  it('accepts reviewed reusable presentation without calling it business-specific', () => {
    const registry = buildCoreBlockRegistry();
    registry.set('layered_hero', {
      id: 'layered_hero', name: 'layered_hero', label: 'Layered hero', category: 'custom',
      container: false, schema: [{ name: 'title', type: 'text', label: 'Title' }],
      template: '<h2>{{title}}</h2>', origin: 'user', created_at: '2026-10-23T00:00:00Z',
    });
    const review = reviewBlockComposition({
      name: 'Renewed landing page',
      blocks: [{ id: 'hero', type: 'layered_hero', data: { title: 'Hello' } }],
      reviewed_custom_block_types: [{ type: 'layered_hero', reason: 'Editable layered presentation; standard alternatives reviewed.' }],
    }, registry);
    expect(review.status).toBe('ready');
    expect(review.business_specific_block_types).toEqual([]);
    expect(review.reviewed_exceptions).toEqual([expect.objectContaining({ block_id: 'hero', kind: 'generic_custom_block', reason: expect.any(String) })]);
    expect(review.requires_hosted_verification).toBe(true);
  });

  it('limits HTML acceptance to the exact reviewed block and preserves other blockers', () => {
    const proposal = {
      name: 'Art-directed hero', fields: [],
      blocks: [{ id: 'hero', type: 'core/html', data: { html: '<div>Unique artwork</div>' } }],
      reviewed_html_blocks: [{ block_id: 'hero', reason: 'One-off responsive artwork; alternatives and reduced motion reviewed.' }],
    };
    expect(reviewBlockComposition(proposal, buildCoreBlockRegistry()).status).toBe('ready');
    const review = reviewBlockComposition({
      ...proposal,
      reviewed_custom_block_types: [{ type: 'missing', reason: 'Review cannot create a missing type.' }],
      blocks: [...proposal.blocks,
        { id: 'other', type: 'core/html', data: {} },
        { id: 'missing', type: 'missing', data: { title: '{{page.unknown}}' } },
        { id: 'css', type: 'core/heading', data: {}, style_overrides: { custom_css: 'color:red' } },
      ],
    }, buildCoreBlockRegistry());
    expect(review.status).toBe('waiting_for_native_support');
    expect(review.missing_block_types).toEqual(['missing']);
    expect(review.missing_fields).toEqual(['unknown']);
    expect(review.workarounds.map(row => row.kind)).toEqual(['raw_html', 'custom_css']);
    expect(review.reviewed_exceptions).toHaveLength(1);
    expect(reviewBlockComposition({ ...proposal, reviewed_html_blocks: [{ block_id: 'hero', reason: ' ' }] }, buildCoreBlockRegistry()).status).toBe('waiting_for_native_support');
  });
});
