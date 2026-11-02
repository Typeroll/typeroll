import { describe, expect, it } from 'vitest';
import {
  LATEST_RENDER_VERSION,
  auditDesignTokens,
  blockFieldTypeWarnings,
  buildCoreBlockRegistry,
  collectBlockAssets,
  defaultSiteSettings,
  renderBlock,
} from '../index.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();
const render = (block: Block, renderVersion = LATEST_RENDER_VERSION) => renderBlock(block, { registry, renderVersion });
const openingTag = (html: string) => html.match(/^<[a-z]+[^>]*>/)![0];

const prose = (data: Record<string, unknown>): Block => ({ id: 'label', type: 'core/prose', data: { html: '<p>Få prisuppgifter:</p>', ...data } });
const text = (data: Record<string, unknown>): Block => ({ id: 'line', type: 'core/text', data: { text: 'Få prisuppgifter:', ...data } });

describe('text colour on core/prose and core/text', () => {
  it('declares the same optional colour field as core/heading', () => {
    const heading = registry.get('core/heading')!.schema!.find(f => f.name === 'color');
    for (const id of ['core/prose', 'core/text']) {
      const field = registry.get(id)!.schema!.find(f => f.name === 'color');
      expect(field, id).toEqual(heading);
      expect(field!.required, id).toBeFalsy();
      expect(field!.default, id).toBeUndefined();
    }
  });

  it('renders a palette token as its CSS variable on the block element', () => {
    expect(openingTag(render(prose({ color: 'on_secondary' }))))
      .toContain('style="--text_align:inherit;--font_weight:inherit;color:var(--color-on-secondary)"');
    expect(openingTag(render(text({ tag: 'span', color: 'on_secondary' }))))
      .toBe('<span data-block="text" class="block-text" data-align="inherit" style="color:var(--color-on-secondary)">');
    expect(openingTag(render(prose({ color: '#123456' })))).toContain(';color:#123456"');
    expect(openingTag(render(text({ color: 'var(--color-primary)' })))).toContain('style="color:var(--color-primary)"');
  });

  it('renders a non-heading label with colour, size and weight using native fields only', () => {
    const html = render(prose({ color: 'on_secondary', font_size_px: 18, font_weight: '700' }));
    const tag = openingTag(html);
    expect(tag).toContain('color:var(--color-on-secondary)');
    expect(tag).toContain('--font_weight:700');
    expect(tag).toContain('--font_size_px:18px');
    expect(html).toContain('<p>Få prisuppgifter:</p>');
    expect(html).not.toMatch(/<h[1-6]\b/);
  });

  it('renders byte-identical output without a colour, on every render version', () => {
    for (let version = 1; version <= LATEST_RENDER_VERSION; version++) {
      for (const [make, base] of [[prose, { font_size_px: 18, font_weight: '700' }], [text, { tag: 'strong' }]] as const) {
        const plain = render(make(base), version);
        expect(render(make({ ...base, color: '' }), version)).toBe(plain);
        expect(render(make({ ...base, color: 'not a colour' }), version)).toBe(plain);
        expect(render(make({ ...base, color: 'red;background:url(x)' }), version)).toBe(plain);
        expect(plain).not.toContain('color:');
      }
    }
    // Block CSS does not change: the colour lives on the element only.
    const css = (blocks: Block[]) => collectBlockAssets(blocks, registry, { renderVersion: LATEST_RENDER_VERSION }).css;
    expect(css([prose({ color: 'on_secondary' }), text({ color: 'on_secondary' })])).toBe(css([prose({}), text({})]));
  });

  it('accepts palette tokens and CSS colours, and warns about anything else', () => {
    for (const color of ['on_secondary', 'on_primary', 'on_accent', 'text', 'text_light', 'primary', '#fff', 'var(--color-secondary)', '{{props.color}}']) {
      expect(blockFieldTypeWarnings([prose({ color }), text({ color })], registry), color).toEqual([]);
    }
    const warnings = blockFieldTypeWarnings([prose({ color: 'on-secondary' }), text({ color: 12 })], registry);
    expect(warnings.map(w => [w.path, w.field])).toEqual([['blocks[0].data.color', 'color'], ['blocks[1].data.color', 'color']]);
    expect(warnings[0]!.expected).toContain('palette name');
  });

  it('binds a composed block prop to the colour', () => {
    const html = renderBlock(text({ color: '{{props.tone}}' }), {
      registry, renderVersion: LATEST_RENDER_VERSION, context: { props: { tone: 'on_secondary' } } as never,
    });
    expect(openingTag(html)).toContain('style="color:var(--color-on-secondary)"');
  });

  it('is linted like core/heading colours by lint_design_tokens', () => {
    const findings = auditDesignTokens(defaultSiteSettings, [{ kind: 'partial', id: 'header', blocks: [prose({ color: '#123456' }), text({ color: 'on_secondary' })] }], registry);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'hardcoded_color', path: 'blocks[0].data.color', value: '#123456', block_id: 'label' });
  });
});
