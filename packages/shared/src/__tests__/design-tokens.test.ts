import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, renderBlocks, blockFieldTypeWarnings, siteThemeCss, defaultSiteSettings, validColor, designScalesError, siteStylesCss, newSiteStyles, resolveBreakpointWidths, tokenScale, composePageWithTemplate } from '../index.js';
const registry = buildCoreBlockRegistry();
describe('site design tokens', () => {
  it('renders palette names on blocks while preserving stored names', () => {
    const blocks = [{ id: 'card', type: 'core/post_card', data: { title: 'Card', background: 'surface', hover_background: 'surface_hover', hover_color: 'on_primary' } }];
    const html = renderBlocks(blocks, { registry });
    expect(html).toContain('--card-bg:var(--color-surface)');
    expect(html).toContain('--card-hover-bg:var(--color-surface-hover)');
    expect(html).toContain('--card-hover-fg:var(--color-on-primary)');
    expect(blocks[0].data.background).toBe('surface');
    expect(blockFieldTypeWarnings(blocks, registry)).toEqual([]);
  });
  it('reports unknown colour names with a field path and omits their output', () => {
    const blocks = [{ id: 'card', type: 'core/post_card', data: { background: 'surfase' } }];
    expect(blockFieldTypeWarnings(blocks, registry)).toEqual([expect.objectContaining({ code: 'field_type_mismatch', path: 'blocks[0].data.background' })]);
    expect(renderBlocks(blocks, { registry })).not.toContain('surfase');
  });
  it('renders responsive named size, spacing and leading steps', () => {
    const blocks = [{ id: 'text', type: 'core/prose', data: { html: '<p>Text</p>', font_size_px: { mobile: 'md', desktop: 'xl' }, line_height: 'relaxed' } }, { id: 'container', type: 'core/container', data: { gap_px: 'lg' }, children: [] }];
    const html = renderBlocks(blocks, { registry });
    expect(html).toContain('--font_size_px:var(--type-size-md)');
    expect(html).toContain('--font_size_px: var(--type-size-xl)');
    expect(html).toContain('--line_height:var(--leading-relaxed)');
    expect(html).toContain('--gap_px:var(--space-lg)');
    expect(blockFieldTypeWarnings(blocks, registry)).toEqual([]);
  });
  it('validates colours inside the selected listing item schema', () => {
    const warnings = blockFieldTypeWarnings([{id:'list',type:'core/page_list',data:{item_overrides:{background:'surfase'}}}],registry);
    expect(warnings).toEqual([expect.objectContaining({code:'field_type_mismatch',path:'blocks[0].data.item_overrides.background'})]);
  });
  it('applies named scales through the page template content slot', () => {
    const template = [{id:'content',type:'template_content_slot',data:{font_size:'md',line_height:'relaxed',paragraph_spacing:'lg'}}];
    expect(blockFieldTypeWarnings(template,registry)).toEqual([]);
    const html = renderBlocks(composePageWithTemplate(template,[{id:'body',type:'core/prose',data:{html:'<p>Content</p>'}}]),{registry});
    expect(html).toContain('--page-body-font-size:var(--type-size-md)');
    expect(html).toContain('--page-body-paragraph-spacing:var(--space-lg)');
  });
  it('retains pixel exceptions and does not treat counts as spacing', () => {
    const blocks = [{ id: 'x', type: 'core/container', data: { gap_px: 24 } }];
    expect(renderBlocks(blocks, { registry })).toContain('--gap_px:24px');
    expect(blockFieldTypeWarnings([{ id: 'x', type: 'core/repeater', data: { cols: 'lg' } }], registry).length).toBeGreaterThan(0);
  });
  it('shares configurable scales and palette variables between consumers', () => {
    const settings = { ...defaultSiteSettings, design_scales: { space: { lg: '2rem' } }, fonts: { ...defaultSiteSettings.fonts, mono: 'Roboto Mono' } };
    expect(siteThemeCss(settings)).toContain('--space-lg:2rem');
    expect(siteThemeCss(settings)).toContain("--font-mono:'Roboto Mono'");
    expect(designScalesError({ space: { lg: '1px;display:none' } })).toBeTruthy();
    expect(designScalesError({ unknown: {} })).toBeTruthy();
    const styles = newSiteStyles(); styles[0].base.size = 'md';
    expect(siteStylesCss(styles, { colors: settings.colors, breakpoints: resolveBreakpointWidths() })).toContain('--body-size:var(--type-size-md)');
  });
  it('resolves a bound colour through the same palette contract', () => {
    const blocks = [{ id:'bound', type:'core/section', data:{background:'{{page.fields.tone}}'}, children:[] }];
    const html = renderBlocks(blocks, { registry, context: { page: { fields:{tone:'surface'} } } as never });
    expect(html).toContain('var(--color-surface)');
    expect(html).not.toContain('{{page.fields.tone}}');
    expect(blockFieldTypeWarnings(blocks, registry)).toEqual([]);
  });
  it('does not advertise tokens for legacy numeric template substitutions', () => {
    expect(tokenScale({name:'font_size', label:'Size', type:'number'})).toBeUndefined();
    expect(tokenScale({name:'title_size_px', label:'Title size', type:'number', css_unit:'px'})).toBe('type_size');
  });
  it('accepts palette-derived mixes and rejects CSS injection', () => {
    expect(validColor('color-mix(in srgb, var(--color-surface) 92%, var(--color-primary))')).toBe(true);
    for (const value of ['unknown', 'red;display:none', 'url(https://example.com)', 'color-mix(in srgb, red;foo, #fff)']) expect(validColor(value)).toBe(false);
  });
});
