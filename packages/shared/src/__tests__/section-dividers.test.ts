import { describe, it, expect } from 'vitest';
import { renderBlock, collectBlockAssets } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { SITE_TEMPLATE_CAPABILITIES } from '../site-template-capabilities.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();

function sectionBlock(data: Record<string, unknown>): Block {
  return { id: 'blk_sec', type: 'core/section', data, children: [] };
}

describe('core/section dividers', () => {
  it('the section schema exposes divider_top + divider_bottom selects', () => {
    const section = registry.get('core/section')!;
    const names = (section.schema ?? []).map((f) => f.name);
    expect(names).toContain('divider_top');
    expect(names).toContain('divider_bottom');
    const top = section.schema!.find((f) => f.name === 'divider_top')!;
    expect(top.type).toBe('select');
    expect(top.options).toEqual(['none', 'wave', 'curve', 'tilt']);
    expect(top.default).toBe('none');
  });

  it('renders the divider data-attributes and the two shape spans', () => {
    const html = renderBlock(
      sectionBlock({ width: 'full', background: '#1F4FB8', divider_top: 'wave', divider_bottom: 'curve' }),
      { registry },
    );
    expect(html).toContain('data-divtop="wave"');
    expect(html).toContain('data-divbot="curve"');
    expect(html).toContain('block-section-shape--top');
    expect(html).toContain('block-section-shape--bot');
    // The shape paints in the section's own background → never needs the neighbour.
    expect(html).toContain('--block-bg:#1F4FB8');
  });

  it('bundles a mask only for the shapes the page actually uses', () => {
    const { css } = collectBlockAssets([sectionBlock({ divider_top: 'wave' })], registry);
    // The full core/section stylesheet ships (block CSS is per-type, not per-value),
    // so every shape's mask is present and the divider is opt-in via data-attr.
    expect(css).toContain('[data-block="section"][data-divtop="wave"] > .block-section-shape--top');
    expect(css).toContain('[data-block="section"][data-divbot="curve"] > .block-section-shape--bot');
    expect(css).toContain('mask-image');
    // 1px overlap is what guarantees a seam-free junction — lock it in.
    expect(css).toContain('translateY(calc(-100% + 1px))');
    expect(css).toContain('translateY(calc(100% - 1px))');
  });

  it('every divider selector is scoped under [data-block="section"] (no global leak)', () => {
    const section = registry.get('core/section')!;
    const inner = (section.styles ?? '').replace(/@media[^{]+\{[\s\S]*?\}\s*\}/g, '');
    const selectors = inner
      .split('}')
      .map((s) => s.split('{')[0]?.trim() ?? '')
      .filter(Boolean)
      .flatMap((s) => s.split(',').map((p) => p.trim()))
      .filter(Boolean)
      .filter((s) => !s.startsWith('/*'));
    for (const sel of selectors) {
      expect(sel, `unscoped section selector: ${sel}`).toMatch(/\[data-block="section"\]/);
    }
  });

  it('is advertised in the capability manifest', () => {
    expect(SITE_TEMPLATE_CAPABILITIES.supports_section_dividers).toBe(true);
  });
});
