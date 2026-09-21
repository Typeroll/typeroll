import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, collectBlockAssets, composePageWithTemplate, type Block } from '../index.js';
const registry = buildCoreBlockRegistry();
const widths = { tablet: 577, laptop: 769, desktop: 1024, wide: 1280 };
describe('native media framing and shared article typography', () => {
  it('exposes responsive framing and retains intrinsic image dimensions with clipping inside the link', () => {
    const tree: Block[] = [{ id:'image',type:'core/image',data:{src:'/drawing.svg',alt:'Drawing',link:'/',original_width:600,original_height:150,scale_percent:{mobile:120,tablet:100},focal_x:50,fit:{mobile:'contain',laptop:'cover'},responsive_breakpoints:widths} }];
    const html = renderBlocks(tree,{registry});
    expect(html).toContain('class="block-image-link"><span class="block-image-frame">');
    expect(html).toContain('width="600" height="150"');
    expect(html).toContain('--scale_percent:120');
    expect(html).toContain('min-width: 577px');
    expect(html).toContain('--image-fit:cover');
    expect(registry.get('core/post_card')!.schema.find(f=>f.name==='image_fit')?.responsive).toBe(true);
    expect(registry.get('core/post_card')!.schema.find(f=>f.name==='focal_x')?.css_unit).toBe('number');
  });
  it('keeps breadcrumb ordered-list semantics with continuous inline items', () => {
    const blocks: Block[]=[{id:'trail',type:'template/page_breadcrumbs',data:{}}];
    const html=renderBlocks(blocks,{registry,context:{page:{breadcrumbs:[{label:'A long current title',current:true}]}}});
    expect(html).toContain('<ol role="list">');
    expect(html).toContain('aria-current="page"');
    const css=collectBlockAssets(blocks,registry).css;
    expect(css).toMatch(/breadcrumbs"\] li \{[^}]*display:inline/);
    expect(css).not.toContain('flex-wrap:wrap');
  });
  it('scopes responsive typography to the content slot while preserving authored sizes and source blocks', () => {
    const body: Block[]=[{id:'heading',type:'core/heading',data:{level:'h2',text:'Heading',size:'article'}},{id:'custom',type:'core/heading',data:{level:'h3',text:'Custom',font_size_px:42}}];
    const slot: Block[]=[{id:'body',type:'template_content_slot',data:{h2_size_px:{mobile:24,tablet:28,laptop:32},responsive_breakpoints:widths}}];
    const composed=composePageWithTemplate(slot,body);
    const html=renderBlocks(composed,{registry});
    expect(html).toContain('--h2_size_px:24px');
    expect(html).toContain('--h2_size_px: 32px');
    expect(html).toContain('min-width: 769px');
    expect(html).toContain('--font_size_px:42px');
    expect(body[0].data).not.toHaveProperty('font_size_px');
  });
});
