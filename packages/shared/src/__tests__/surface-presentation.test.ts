import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, getPartialCompositionStarter, renderBlocks, type Block } from '../index.js';

const registry = buildCoreBlockRegistry();
const render = (type: string, data: Record<string, unknown>) => renderBlocks([{ id: 'surface', type, data }], { registry });

describe('native surface presentation', () => {
  it('offers explicit compact navigation at every width with a responsive minimum height', () => {
    const schema = registry.get('core/navigation_links')!.schema;
    expect(schema.find(field => field.name === 'density')?.options).toContain('compact');
    expect(schema.find(field => field.name === 'link_min_height_px')).toMatchObject({ responsive: true, min: 24 });
    const html = render('core/navigation_links', { density: 'compact', links: [{ label: 'Guide', href: '/guide/' }], link_min_height_px: { mobile: 24, desktop: 32 } });
    expect(html).toContain('data-density="compact"');
    expect(html).toContain('--link_min_height_px:24px');
    expect(html).toMatch(/--link_min_height_px:\s*32px/);
  });
  it.each(['core/container', 'core/section'])('renders optional typed gradients on %s', type => {
    expect(render(type, { background_gradient: { from: '#f8fbff', to: '#e8f4fc', angle: 135 } })).toContain('linear-gradient(135deg,#f8fbff 0%,#e8f4fc 100%)');
    expect(render(type, { background: '#e8f4fc' })).not.toContain('linear-gradient(');
    expect(render(type, { background_gradient: { from: '#fff' } })).not.toContain('linear-gradient(');
    expect(render(type, { background_gradient: { from: 'red);background:url(evil)', to: '#fff' } })).not.toContain('linear-gradient(');
    expect(render(type, { background_gradient: { from: '#fff', to: '#000', angle: '0);bad:yes' } })).not.toContain('linear-gradient(');
  });
  it('exposes paired card and download feedback colors without changing link structure', () => {
    const html = render('core/post_card', { title: 'Guide', href: '/', whole_card_link: true, hover_background: '#e8f4fc', hover_border_color: '#186ec0' });
    expect(html).toContain('--card-hover-bg:#e8f4fc');
    expect(html).toContain('--card-hover-border:#186ec0');
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(registry.get('core/post_card')!.schema.some(field => field.name === 'download_hover_color')).toBe(true);
  });
  it('offers compact desktop footer links without changing primary menu defaults', () => {
    const schema = registry.get('core/navigation_links')!.schema;
    expect(schema.find(field => field.name === 'density')?.default).toBe('comfortable');
    const footer = getPartialCompositionStarter('footer', { links: [{ label: 'Home', href: '/' }] });
    expect(renderBlocks(footer, { registry })).toContain('data-density="compact-desktop"');
    const ordinary: Block[] = [{ id: 'nav', type: 'core/navigation_links', data: { links: [{ label: 'Home', href: '/' }] } }];
    expect(renderBlocks(ordinary, { registry })).toContain('data-density="comfortable"');
    expect(collectBlockAssets(ordinary, registry).css).toContain('pointer:fine');
  });
});
