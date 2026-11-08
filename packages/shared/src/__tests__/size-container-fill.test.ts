/**
 * From render version 14 grid cells, columns and tab panels are size containers
 * (container-type: inline-size), which gives their content no width to size by.
 * In a centring or row container the block holding them then shrank to almost
 * nothing (Moveria, 2026-11-08: a 1080px two-column intro became 32px wide).
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFAULTS_V14_CSS } from '../block-defaults.js';

describe('blocks holding size containers fill their container', () => {
  const rule = BLOCK_DEFAULTS_V14_CSS.split('\n').find(line => line.includes('inline-size:100%') && line.startsWith(':where([data-block="container"]) >'));

  it('targets direct children of a container that hold or are a size container', () => {
    expect(rule).toBeDefined();
    for (const part of ['.block-columns-col', '[data-block="grid"] > *', '.block-tabs-panel', '[data-block="hero"]', '[data-block="feature_row"]']) expect(rule).toContain(part);
  });

  it('keeps zero specificity so block settings and site CSS still win', () => {
    expect(rule).toMatch(/^:where\(\[data-block="container"\]\) > :where\(\[data-block\]\):where\(/);
  });
});

describe('version 14 defaults found in the Moveria review', () => {
  it('keeps empty column tracks so one card stays one column wide', () => {
    expect(BLOCK_DEFAULTS_V14_CSS + '').not.toContain('repeat(auto-fit');
  });
});
