import { describe, it, expect } from 'vitest';
import { auditDesignTokens, buildCoreBlockRegistry, defaultSiteSettings } from '../index.js';
const registry = buildCoreBlockRegistry();
const settings = { ...defaultSiteSettings, colors: { ...defaultSiteSettings.colors, surface: '#123456' } };
describe('design token audit', () => {
  it('offers exact unambiguous scalar replacements without mutating source', () => {
    const source = { kind: 'partial' as const, id: 'footer', blocks: [{ id: 'card', type: 'core/post_card', data: { background: '#123456', title: 'Do not change #123456 in prose' } }] };
    const findings = auditDesignTokens(settings, [source], registry);
    expect(findings).toHaveLength(1);
    expect(findings[0].replacement).toEqual({ target: { kind:'partial',id:'footer' }, block_id:'card',field:'background',before:'#123456',after:'surface' });
    expect(source.blocks[0].data.background).toBe('#123456');
  });
  it('audits the actual item schema of listings and static repeaters', () => {
    const findings = auditDesignTokens(settings, [{kind:'page',id:'list',blocks:[
      {id:'listing',type:'core/page_list',data:{item_overrides:{background:'#123456',title_size_px:18}}},
      {id:'static',type:'core/repeater',data:{item_block:'core/post_card',items:[{background:'#123456'}]}},
    ]}],registry);
    expect(findings.filter(f => f.code === 'hardcoded_color')).toHaveLength(2);
    expect(findings.some(f => f.path.endsWith('item_overrides.title_size_px'))).toBe(true);
    expect(findings.every(f => !f.replacement)).toBe(true);
  });
  it('does not infer semantic roles for duplicate palette colours or approximate matches', () => {
    const sources = [{ kind: 'page' as const, id:'home', blocks: [{id:'x',type:'core/post_card',data:{background:'#fff',hover_background:'#123457'}}] }];
    const findings = auditDesignTokens(settings, sources, registry);
    expect(findings[0].exact_matches.length).toBeGreaterThan(1);
    expect(findings.every(f => !f.replacement)).toBe(true);
    expect(findings[1].suggestions[0]).toBe('surface');
  });
  it('checks nested trees, responsive values, styles and CSS without counting URLs or text', () => {
    const found = auditDesignTokens({ ...settings, custom_css: '.card{color:#123456;font-size:18px;font-family:"Arial";padding:2rem}', styles: [{id:'test',name:'Test',targets:['text'],base:{size:'20px',color:'#123456'}}] }, [
      { kind:'template',id:'layout',blocks:[{id:'section',type:'core/section',data:{},children:[{id:'text',type:'core/prose',data:{html:'<p>Price #123456</p>',font_size_px:{mobile:16,desktop:'xl'}}}]}] },
    ], registry);
    expect(found.filter(f => f.code === 'hardcoded_color')).toHaveLength(2);
    expect(found.some(f => f.path.endsWith('font_size_px.mobile'))).toBe(true);
    expect(found.some(f => f.code === 'hardcoded_font')).toBe(true);
    expect(found.filter(f => String(f.value).includes('Price'))).toEqual([]);
  });
});
