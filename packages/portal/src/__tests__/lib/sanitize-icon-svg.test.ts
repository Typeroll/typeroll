// The icon pipeline (shared/src/icons.ts) emits inline stroke-based SVG
// for `type: 'icon'` schema fields. Everything the block renderer produces
// passes through sanitizeBody before it reaches a page or the preview —
// if the sanitizer strips the icon markup, the pipeline silently renders
// empty wells again. This locks the contract.
import { describe, it, expect } from 'vitest';
import { sanitizeBody } from '../../lib/sanitize';
import { renderIconHtml } from '@typeroll/shared';
import { renderBlock, buildCoreBlockRegistry } from '@typeroll/shared';

describe('icon svg survives sanitization', () => {
  it('keeps the inline svg with its stroke attributes', () => {
    const out = sanitizeBody(renderIconHtml('shield-check'));
    expect(out).toContain('<svg');
    expect(out).toContain('stroke="currentColor"');
    expect(out).toContain('<path');
    expect(out).toContain('viewBox="0 0 24 24"');
  });

  it('keeps a fully rendered icon_box block intact', () => {
    const registry = buildCoreBlockRegistry();
    const html = renderBlock(
      {
        id: 'b1',
        type: 'core/icon_box',
        data: { icon: 'rocket', heading: 'Snabbt', heading_level: 'h3', text: '<p>x</p>' },
      },
      { registry },
    );
    const out = sanitizeBody(html);
    expect(out).toMatch(/class="block-iconbox-icon"[^>]*><svg /);
  });
});
