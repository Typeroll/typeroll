import { describe, it, expect } from 'vitest';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();

describe('tabs direct link relationship', () => {
  it('publishes link_rel and new_tab on direct-link choices, and nothing when unset', () => {
    const html = renderBlock({ id: 't', type: 'core/tabs', data: { labels: [
      { label: 'Partner', href: 'https://partner.example/?ref=x', link_rel: 'nofollow sponsored' },
      { label: 'Shop', href: 'https://shop.example/', new_tab: true },
      { label: 'Plain', href: '/plain' },
    ] }, slots: [] } as Block, { registry });
    expect(html).toContain('<a class="block-tabs-choice" href="https://partner.example/?ref=x" rel="nofollow sponsored">');
    expect(html).toContain('<a class="block-tabs-choice" href="https://shop.example/" target="_blank" rel="noopener noreferrer">');
    expect(html).toContain('<a class="block-tabs-choice" href="/plain">');
  });

  it('exposes the fields in the choices schema', () => {
    const labels = registry.get('core/tabs')!.schema.find(field => field.name === 'labels')!;
    expect(labels.fields!.map(field => field.name)).toEqual(expect.arrayContaining(['link_rel', 'new_tab']));
  });
});
