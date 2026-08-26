import { describe, it, expect } from 'vitest';
import { CORE_ICONS, CORE_ICON_NAMES, renderIconHtml } from '../icons.js';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';

const registry = buildCoreBlockRegistry();

describe('renderIconHtml', () => {
  it('renders a known name as an inline 1em stroke svg', () => {
    const html = renderIconHtml('check');
    expect(html.startsWith('<svg ')).toBe(true);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('width="1em"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(CORE_ICONS['check']);
  });

  it('passes emoji through HTML-escaped (pre-pipeline workaround)', () => {
    expect(renderIconHtml('🎉')).toBe('🎉');
    expect(renderIconHtml('')).toBe('');
  });

  it('escapes markup in unknown values — no injection through icon fields', () => {
    const html = renderIconHtml('<img onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('exposes a sorted, non-empty name list for capabilities', () => {
    expect(CORE_ICON_NAMES.length).toBeGreaterThan(100);
    expect([...CORE_ICON_NAMES]).toEqual([...CORE_ICON_NAMES].sort());
    for (const n of ['check', 'star', 'mail', 'arrow-right', 'shield-check']) {
      expect(CORE_ICON_NAMES).toContain(n);
    }
  });

  it('every embedded icon body is markup-safe (no scripts, no event handlers)', () => {
    for (const [name, inner] of Object.entries(CORE_ICONS)) {
      expect(inner, name).not.toMatch(/<script|on[a-z]+=|javascript:/i);
    }
  });
});

describe('icon pipeline through renderBlock', () => {
  it('core/icon renders the svg inside the link', () => {
    const html = renderBlock(
      { id: 'i1', type: 'core/icon', data: { icon: 'star', size: 'md', align: 'left' } },
      { registry },
    );
    expect(html).toContain('data-icon="star"');
    expect(html).toMatch(/<a [^>]*class="block-icon-link"[^>]*><svg /);
  });

  it('core/icon_box renders the svg in the icon well', () => {
    const html = renderBlock(
      {
        id: 'b1',
        type: 'core/icon_box',
        data: { icon: 'shield-check', heading: 'Tryggt', heading_level: 'h3', text: '<p>x</p>' },
      },
      { registry },
    );
    expect(html).toMatch(/class="block-iconbox-icon"[^>]*><svg /);
  });

  it('core/step_card keeps emoji stand-ins as text', () => {
    const html = renderBlock(
      {
        id: 's1',
        type: 'core/step_card',
        data: { number: '1', icon: '⚽', title: 'Anslut', text: '<p>x</p>' },
      },
      { registry },
    );
    expect(html).toContain('<span class="block-step-icon" data-icon="⚽">⚽</span>');
    expect(html).not.toContain('block-step-icon" data-icon="⚽"><svg');
  });

  it('empty icon value renders an empty well, no svg', () => {
    const html = renderBlock(
      { id: 'i2', type: 'core/icon', data: { icon: '', size: 'md', align: 'left' } },
      { registry },
    );
    expect(html).not.toContain('<svg');
  });
});
