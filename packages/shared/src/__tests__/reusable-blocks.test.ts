import { describe, it, expect } from 'vitest';
import {
  blockTemplateId,
  buildCoreBlockRegistry,
  collectBlockAssets,
  copyBlocksWithNewIds,
  globalBlockRefs,
  globalBlockSourceFromPartials,
  renderBlocks,
  validateBlockTemplateInput,
} from '../index.js';
import type { Block, Partial } from '../index.js';

const registry = buildCoreBlockRegistry();
const cta: Block[] = [{ id: 'cta-section', type: 'core/section', data: {}, children: [{ id: 'cta-heading', type: 'core/heading', data: { text: 'Book a call', level: 'h2' } }] }];
const partials: Partial[] = [
  { id: 'cta', name: 'Call to action', kind: 'free', content_mode: 'blocks', blocks: cta, status: 'published' },
  { id: 'draft', name: 'Draft', kind: 'free', content_mode: 'blocks', blocks: cta, status: 'draft' },
  { id: 'legacy', name: 'Legacy', kind: 'free', content_mode: 'html', html_content: '<aside class="note">Old</aside>', status: 'published' },
  { id: 'loop', name: 'Loop', kind: 'free', content_mode: 'blocks', blocks: [{ id: 'self', type: 'core/global_block', data: { global_block_id: 'loop' } }], status: 'published' },
];
const globalBlockSource = globalBlockSourceFromPartials(partials);
const ref = (id: string, blockId = 'ref'): Block => ({ id: blockId, type: 'core/global_block', data: { global_block_id: id } });

describe('global blocks', () => {
  it('render the published blocks in place, without a wrapper', () => {
    const withRef = renderBlocks([ref('cta')], { registry, globalBlockSource });
    const direct = renderBlocks(cta, { registry });
    expect(withRef.replace(/ data-global-block="cta"/g, '')).toBe(direct);
    expect(withRef).toMatch(/^<section[^>]*data-global-block="cta"/);
  });

  it('annotate the reference, not the inner blocks, in the editor', () => {
    const html = renderBlocks([ref('cta')], { registry, globalBlockSource, annotate: true });
    expect(html).toContain('data-block-id="ref"');
    expect(html).not.toContain('data-block-id="cta-heading"');
  });

  it('render HTML-mode global blocks and skip drafts, missing ids and cycles', () => {
    expect(renderBlocks([ref('legacy')], { registry, globalBlockSource })).toBe('<aside class="note" data-global-block="legacy">Old</aside>');
    expect(renderBlocks([ref('draft')], { registry, globalBlockSource })).toBe('<!-- Global block &quot;draft&quot; is missing or not published -->');
    expect(renderBlocks([ref('draft')], { registry, globalBlockSource, annotate: true })).toContain('data-missing="true"');
    expect(renderBlocks([ref('loop')], { registry, globalBlockSource })).toContain('includes itself');
  });

  it('bring the block CSS of referenced content into the bundle', () => {
    const page: Block[] = [ref('cta')];
    expect(collectBlockAssets(page, registry).used_ids).not.toContain('core/heading');
    expect(collectBlockAssets(page, registry, { globalBlockSource }).used_ids).toEqual(expect.arrayContaining(['core/heading', 'core/section']));
  });

  it('list references across children and slots', () => {
    expect(globalBlockRefs([{ id: 'a', type: 'core/section', data: {}, children: [ref('cta', 'r1'), ref('cta', 'r2')] }, { id: 'c', type: 'core/columns', data: {}, slots: [[ref('legacy', 'r3')]] }])).toEqual(['cta', 'legacy']);
  });
});

describe('block templates', () => {
  it('copy blocks with new ids throughout the tree', () => {
    const copy = copyBlocksWithNewIds(cta);
    expect(copy[0].id).not.toBe('cta-section');
    expect(copy[0].children?.[0].id).not.toBe('cta-heading');
    expect(copy[0].children?.[0].data).toEqual(cta[0].children?.[0].data);
    copy[0].children![0].data.text = 'Changed';
    expect(cta[0].children?.[0].data.text).toBe('Book a call');
  });

  it('validate input and derive unique ids', () => {
    expect(validateBlockTemplateInput({ name: 'Pricing', blocks: cta }).value?.name).toBe('Pricing');
    expect(validateBlockTemplateInput({ name: '', blocks: cta }).error).toMatch(/name/);
    expect(validateBlockTemplateInput({ name: 'X', blocks: [] }).error).toMatch(/blocks/);
    expect(validateBlockTemplateInput({ name: 'X', blocks: cta, extra: 1 }).error).toMatch(/Unknown/);
    expect(validateBlockTemplateInput({ description: 'Only text' }, true).value).toEqual({ description: 'Only text' });
    expect(blockTemplateId('Prissektion för företag', ['prissektion-for-foretag'])).toBe('prissektion-for-foretag-2');
  });
});
