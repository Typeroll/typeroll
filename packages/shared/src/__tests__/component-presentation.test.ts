import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlocks } from '../render-blocks.js';
import { blockTreeError } from '../block-tree-validation.js';
import type { Block } from '../types.js';
const registry = buildCoreBlockRegistry();
const siteWidths = { tablet: 577, laptop: 769, desktop: 1024, wide: 1280 };
const localWidths = { tablet: 481, laptop: 992, desktop: 1041, wide: 1440 };
const render = (blocks: Block[]) => renderBlocks(blocks, { registry, context: { site: { responsive_breakpoints: siteWidths }, item: { pdf: '/guide.pdf' } } });
describe('independent component presentation', () => {
  it('keeps component ranges local, including repeated cards and visibility', () => {
    const html = render([
      { id: 'local', type: 'core/post_card', hidden_on: ['tablet'], data: { responsive_breakpoints: localWidths, title: 'Guide', layout: { mobile: 'column', desktop: 'row' } } },
      { id: 'site', type: 'core/container', data: { min_height_px: { mobile: 80, laptop: 103 } } },
      { id: 'listing', type: 'core/page_list', data: { source_type: 'static', items: [{ title: 'One' }], cols: { mobile: 1, tablet: 2 }, item_overrides: { responsive_breakpoints: localWidths, title_size_px: { mobile: 14, desktop: 22 } } } },
    ]);
    expect(html).toContain('@media (min-width: 1041px)');
    expect(html).toContain('(min-width: 481px) and (width < 992px)');
    expect(html).toContain('@media (min-width: 769px)');
    expect(html).toContain('@media (min-width: 577px)');
    expect(html.match(/@media \(min-width: 1041px\)/g)).toHaveLength(2);
  });
  it('rejects unsafe or incomplete component maps at the save/export boundary, including item overrides', () => {
    for (const responsive_breakpoints of [{ desktop: 1041 }, { ...localWidths, laptop: 481 }, { ...localWidths, desktop: '1041px' }, { ...localWidths, wide: 3000 }]) {
      expect(blockTreeError([{id:'bad',type:'core/post_card',data:{responsive_breakpoints}}])).toContain('data.responsive_breakpoints');
      expect(blockTreeError([{id:'list',type:'core/page_list',data:{item_overrides:{responsive_breakpoints}}}])).toContain('item_overrides.responsive_breakpoints');
    }
    expect(blockTreeError([{id:'reset',type:'core/post_card',data:{responsive_breakpoints:null}}])).toBeNull();
  });
  it('retains independent title, page action and explicit download policy', () => {
    const html = render([{id:'card',type:'core/post_card',data:{title:'Packing',href:'/packing',action_label:'Read',download_url_field:'pdf',download_behavior:'download',whole_card_link:true}}]);
    expect(html).toContain('class="block-postcard-link"><span>Packing</span></a>');
    expect(html).toMatch(/class="block-postcard-download"[^>]* download/);
    expect(html).toContain('data-whole="false"');
    const unlinked = render([{id:'card',type:'core/post_card',data:{title:'Packing',href:'/packing',title_link:false,action_label:'Read',download_url_field:'pdf',download_behavior:'navigate'}}]);
    expect(unlinked).not.toContain('class="block-postcard-link"><span>Packing');
    expect(unlinked).not.toMatch(/<a[^>]* download/);
  });
  it('keeps the image target when the title link is explicitly disabled', () => {
    const html = render([{id:'card',type:'core/post_card',data:{title:'Packing',href:'/packing',image:'/packing.jpg',whole_card_link:true,title_link:false}}]);
    expect(html).toContain('data-whole="false"');
    expect(html).toContain('<a href="/packing" class="block-postcard-link" aria-label="Packing"><img');
  });
  it('exposes typed media, surface, action and layout controls through the registry', () => {
    const fields = (id: string) => registry.get(id)!.schema.map(f => f.name);
    expect(fields('core/post_card')).toEqual(expect.arrayContaining(['responsive_breakpoints','image_sizing','border_width_px','border_color','background','body_padding_x_px','body_padding_y_px','title_font','download_width','download_padding_x_px','download_weight','actions_align']));
    expect(fields('core/columns')).toEqual(expect.arrayContaining(['left_width_px','stack_below_px']));
    expect(fields('core/container')).toEqual(expect.arrayContaining(['radius_px','shadow']));
    expect(fields('core/navigation_menu')).toContain('close_size_px');
    const html = render([{id:'nav',type:'core/navigation_menu',data:{}}]);
    expect(html).toContain('<svg'); expect(html).not.toContain('>×<');
  });
});
