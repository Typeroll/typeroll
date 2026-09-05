import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlocks } from '../render-blocks.js';
import { getArchiveCompositionStarter, getPartialCompositionStarter } from '../site-compositions.js';

describe('native site compositions', () => {
  const registry = buildCoreBlockRegistry();

  it('renders a semantic header navigation with current-page state', () => {
    const blocks = getPartialCompositionStarter('header', {
      links: [{ label: 'Home', href: '/' }, { label: 'About', href: '/about/' }],
      navigation_label: 'Primary',
      menu_label: 'Open menu',
    });
    const html = renderBlocks(blocks, {
      registry,
      context: { page: { path: '/about/' }, site: { logo: '/logo.svg', name: 'Example' } },
    });
    expect(html).toContain('<nav data-block="navigation" aria-label="Primary"');
    expect(html).toContain('href="/about/" aria-current="page"');
    expect(html).toContain('aria-expanded="false"');
    const script = registry.get('core/navigation')?.script ?? '';
    expect(script).toContain("matchMedia('(max-width: 720px)')");
    expect(script).toContain("event.key === 'Escape'");
    expect(script).toContain('list.hidden = mobile.matches');
  });

  it('builds an archive with responsive columns and configurable card mappings', () => {
    const blocks = getArchiveCompositionStarter({
      collection: 'articles', title: 'Articles', image_field: 'featured_image',
      image_alt_field: 'featured_image_alt', heading_level: 'h2',
    });
    const list = blocks.find((candidate) => candidate.type === 'core/collection_list');
    expect(list?.data.cols).toEqual({ mobile: 1, tablet: 2, desktop: 3 });
    expect(list?.data.item_overrides).toMatchObject({
      image_field: 'featured_image', image_alt_field: 'featured_image_alt', heading_level: 'h2',
    });
  });
});
