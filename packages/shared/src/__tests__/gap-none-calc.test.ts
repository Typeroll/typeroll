/**
 * Gap "none" feeds column widths computed with calc(). A unitless 0 there makes
 * `100% - (cols - 1) * 0` invalid, the declaration is dropped and a grid with
 * gap none collapsed to one column from render version 14 (Moveria, 2026-11-08).
 */
import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { collectBlockAssets } from '../render-blocks.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();
const css = (block: Block, renderVersion: number) => collectBlockAssets([block], registry, { renderVersion }).css;
const grid: Block = { id: 'g', type: 'core/grid', data: { cols: { mobile: 1, laptop: 2 }, gap: 'none' }, children: [] };

describe('gap none in calc()-based column widths', () => {
  for (const version of [13, 14, 15, 16]) {
    it(`gives grids, containers and repeaters a zero length at render version ${version}`, () => {
      const out = css(grid, version) + css({ id: 'c', type: 'core/container', data: { gap: 'none' }, children: [] }, version)
        + css({ id: 'r', type: 'core/repeater', data: { gap: 'none', layout: 'carousel' } } as Block, version);
      expect(out).not.toMatch(/--(container|rep)-gap:\s*0;/);
      expect(out).toMatch(/--container-gap:\s*0px;/);
    });
  }
});
