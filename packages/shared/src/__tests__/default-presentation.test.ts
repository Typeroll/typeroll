import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, getPageTemplateStarter, getPartialCompositionStarter, getArchiveCompositionStarter, type Block } from '../index.js';
const registry=buildCoreBlockRegistry();
const flatten=(blocks:Block[]):Block[]=>blocks.flatMap(block=>[block,...flatten(block.children??[]),...(block.slots??[]).flatMap(flatten)]);
describe('default presentation contracts',()=>{
  it('keeps typed linked-heading controls through the actual renderer', () => {
    const html = renderBlocks([{ id: 'heading', type: 'core/rich_heading', data: {
      html: '<a href="/guide/">Guide</a>', font_size_px: 20, align: { mobile: 'left', tablet: 'center' },
    } }], { registry });
    expect(html).toContain('--font_size_px:20px');
    expect(html).toMatch(/--align:\s*center/);
    expect(html).toContain('<a href="/guide/">Guide</a>');
    expect(html).not.toContain('[object Object]');
  });
  it('preserves authored padding and leaves presentation values resettable', () => {
    const html = renderBlocks([{ id: 'padded', type: 'core/container', data: { padding_x: 'md', padding_y: 'lg' } }], { registry });
    expect(html).toContain('--padding_x:md');
    expect(html).toContain('--padding_y:lg');
    expect(registry.get('core/rich_heading')!.schema.find(field => field.name === 'html')?.editor_group).toBeUndefined();
    expect(registry.get('core/rich_heading')!.schema.find(field => field.name === 'font_size_px')?.editor_group).toBe('advanced');
  });
  it('uses a native menu with independent readable mobile links in the header starter',()=>{
    const blocks=flatten(getPartialCompositionStarter('header',{links:[{label:'About',href:'/about/'}]}));
    const menu=blocks.find(block=>block.type==='core/navigation_menu');
    expect(menu?.slots?.[0]?.[0].data.direction).toBe('row');
    expect(menu?.slots?.[1]?.[0].data.direction).toBe('column');
  });
  it('omits missing template image, date, excerpt and author rather than leaving layout nodes',()=>{
    for(const type of ['template/page_featured_image','template/page_date','template/page_excerpt','template/page_author']) {
      expect(renderBlocks([{id:'empty',type,data:{}}],{registry,context:{page:{title:'Title'}}})).toBe('');
    }
  });
  it('has one padded frame and native facts in the new profile starter',()=>{
    const tree=getPageTemplateStarter('profile')!;
    expect(tree?.[0]?.type).toBe('core/section');
    expect(flatten(tree??[]).filter(block=>block.type==='template/page_title')).toHaveLength(1);
    expect(flatten(tree??[]).some(block=>block.type==='core/field_list')).toBe(true);
  });
  it('inherits default rhythm without adding padding in each nested container',()=>{
    expect(registry.get('core/container')!.schema.find(field=>field.name==='padding_x')?.default).toBe('none');
    expect(registry.get('core/container')!.schema.find(field=>field.name==='padding_y')?.default).toBe('none');
    expect(registry.get('core/container')!.schema.find(field=>field.name==='overflow')?.default).toBe('visible');
  });
  it('uses the theme title scale and presentable optional cards in archive starters',()=>{
    const blocks=flatten(getArchiveCompositionStarter({content_type:'articles',title:'Articles'}));
    expect(blocks.find(block=>block.type==='core/heading')?.data.size).toBe('auto');
    expect(blocks.find(block=>block.type==='core/page_list')?.data.item_overrides).toMatchObject({appearance:'card'});
  });
});
