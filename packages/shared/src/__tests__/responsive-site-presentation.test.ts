import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlocks } from '../render-blocks.js';
import { resolveBreakpointWidths, responsiveBreakpointsError, breakpointPreviewWidth } from '../breakpoints.js';
import { pageBreadcrumbs } from '../page-breadcrumbs.js';
import type { Block, Page, ContentType } from '../types.js';
const registry = buildCoreBlockRegistry();
const widths = { tablet: 576, laptop: 769, desktop: 1024, wide: 1280 };
const render = (blocks: Block[], custom = true) => renderBlocks(blocks, { registry, context: { site: custom ? { responsive_breakpoints: widths } : {}, item: { pdf: '/guide.pdf' } } });

describe('site-authored responsive presentation', () => {
  it('validates complete increasing widths, rejects injection and supports explicit reset', () => {
    expect(responsiveBreakpointsError(widths)).toBeNull();
    for (const input of [{ tablet: 576 }, { ...widths, laptop: 576 }, { ...widths, wide: 3000 }, { ...widths, tablet: '576px' }, { ...widths, unknown: 1 }]) expect(responsiveBreakpointsError(input)).not.toBeNull();
    expect(resolveBreakpointWidths(null).tablet).toBe(640);
    expect(breakpointPreviewWidth('tablet', resolveBreakpointWidths({ ...widths, laptop: 600 }))).toBe(599);
  });
  it('uses exact site widths for ordinary blocks, aliases and repeater item overrides', () => {
    const blocks: Block[] = [{ id: 'label', type: 'core/prose', data: { html: '<p>Copyright</p>', font_size_px: { mobile: 14.4, laptop: 18 }, text_align: 'center', line_height: 1.6 } },
      { id: 'list', type: 'core/page_list', data: { cols: { mobile: 1, tablet: 2 }, source_type: 'static', items: [{ title: 'First', href: '/first' }], item_overrides: { title_size_px: { mobile: 16, laptop: 20 } } } }];
    const html = render(blocks);
    expect(html).toContain('@media (min-width: 576px)');
    expect(html).toContain('@media (min-width: 769px)');
    expect(html).not.toContain('@media (min-width: 640px)');
    expect(html).toContain('--font_size_px:14.4px');
    expect(render(blocks, false)).toContain('@media (min-width: 1024px)');
  });
  it('uses exclusive upper bounds for hidden ranges and preserves default visibility attributes', () => {
    const blocks: Block[] = [{ id: 'hidden', type: 'core/prose', data: { html: '<p>Hidden</p>' }, hidden_on: ['tablet'] }];
    expect(render(blocks)).toContain('(min-width: 576px) and (width < 769px)');
    expect(render(blocks)).not.toContain('data-hidden-tablet');
    expect(render(blocks, false)).toContain('data-hidden-tablet');
  });
  it('keeps separate page/download actions and a single target for image-free icon cards', () => {
    const html = render([{ id: 'card', type: 'core/post_card', data: { title: 'Guide', href: '/guide', action_label: 'Read', download_url_field: 'pdf', actions_direction: { mobile: 'column', tablet: 'row' }, whole_card_link: true, show_image: false } }]);
    expect(html).toContain('class="block-postcard-actions"');
    expect(html).toContain('href="/guide.pdf"');
    expect(html).toContain('data-whole="false"');
    expect(html).toContain('--actions_direction: row !important');
    const single = render([{ id: 'link', type: 'core/post_card', data: { title: 'Moving advice', href: '/advice', title_icon: 'arrow-right', whole_card_link: true, show_image: false } }]);
    expect(single.match(/<a /g)).toHaveLength(1);
    expect(single).toContain('block-postcard-title-icon');
    expect(single).not.toContain('<a href="/advice" class="block-postcard-action"');
  });
  it('uses short labels in explicit and inferred trails without changing titles or routes', () => {
    const parent = { id: 'tips', title: 'All our detailed moving advice', breadcrumb_label: 'Moving tips', path: '/tips', status: 'published', slug: 'tips' } as Page;
    const child = { id: 'one', title: 'A long article title', breadcrumb_label: 'Packing', path: '/tips/packing', parent: 'tips', slug: 'packing' } as Page;
    expect(pageBreadcrumbs(child, [parent, child], 'always')).toEqual([{ label: 'Moving tips', href: '/tips/' }, { label: 'Packing', href: '/tips/packing/', current: true }]);
    const inferred = pageBreadcrumbs({ ...child, parent: null }, [parent, child], 'always', {
      id: 'article', route_template: '/tips/{slug}', label_plural: 'Articles', fields: [],
    } as unknown as ContentType);
    expect(inferred[0]).toEqual({ label: 'Moving tips', href: '/tips/' });
    expect(child.title).toBe('A long article title');
    child.breadcrumb_label = ' ';
    expect(pageBreadcrumbs(child, [parent, child]).at(-1)?.label).toBe(child.title);
  });
});
