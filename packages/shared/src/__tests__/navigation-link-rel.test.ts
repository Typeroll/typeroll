import { describe, it, expect } from 'vitest';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();

describe('navigation link relationship', () => {
  it('publishes link_rel on navigation and link-list entries, and nothing when unset', () => {
    for (const type of ['core/navigation', 'core/navigation_links']) {
      const html = renderBlock({ id: 'nav', type, data: { links: [
        { label: 'Partner', href: 'https://partner.example/', link_rel: 'nofollow sponsored' },
        { label: 'Home', href: '/' },
      ] } } as Block, { registry });
      expect(html).toContain('<a href="https://partner.example/" rel="nofollow sponsored">');
      expect(html).toContain('<a href="/" aria-current="page">');
    }
  });
});
