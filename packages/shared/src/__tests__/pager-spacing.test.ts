/**
 * A list's pager is emitted by the repeater after its items. Containers reset
 * their children's margins from render version 14, which glued the pager to the
 * last row of cards (Moveria, 2026-11-08).
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_TYPE_DEFAULTS_V14 } from '../block-defaults.js';

describe('pager spacing inside containers', () => {
  it('leaves the pager out of the container margin reset', () => {
    const css = Object.values(BLOCK_TYPE_DEFAULTS_V14).join('\n');
    expect(css).toContain('> [data-block]:not(:where([data-block="pager"])) { margin-block:0; }');
    expect(css).not.toMatch(/> \[data-block\] \{ margin-block:0; \}/);
  });
  it('lays out repeater grids with auto-fill', () => {
    expect(BLOCK_TYPE_DEFAULTS_V14['core/repeater']).toContain('repeat(auto-fill');
  });
});
