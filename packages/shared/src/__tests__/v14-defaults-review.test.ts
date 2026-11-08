/**
 * Version 14 defaults that broke existing layouts, found when the Moveria sites
 * were compared at render version 16 against 11–13 (2026-11-08).
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFAULTS_V14_CSS, BLOCK_TYPE_DEFAULTS_V14, BLOCK_TYPE_DEFAULTS_V16 } from '../block-defaults.js';
import { CONTENT_WELL_V14_CSS } from '../content-well.js';

const v14 = BLOCK_DEFAULTS_V14_CSS + Object.values(BLOCK_TYPE_DEFAULTS_V14).join('\n');

describe('version 14 defaults', () => {
  it('does not hyphenate button labels or table cells that fit', () => {
    expect(v14).not.toContain('hyphens:auto');
  });

  it('keeps breadcrumb and table-of-contents links inline so they wrap with the text', () => {
    expect(v14).toContain('[data-block="breadcrumbs"] a { padding-block:.25rem; }');
    expect(v14).toContain('[data-block="table_of_contents"] a { padding-block:.15rem; }');
    expect(v14).not.toMatch(/\[data-block="(breadcrumbs|table_of_contents)"\] a \{ display:inline-block/);
  });

  it('removes only automatic padding from a plain section inside a container', () => {
    expect(v14).toContain('[data-block="section"]:is([data-pad="auto"],:not([data-pad]))');
    expect(v14).not.toContain('[style*="--block-bg:;"]:not([style*="--surface"]) { padding:0; }');
  });

  it('adds no page-end space after a full-width container, which pads itself like a section', () => {
    expect(CONTENT_WELL_V14_CSS).toContain(':not([data-block="section"],[data-block="hero"],[data-block="container"][data-width="full"],[data-block="semantic-container"][data-width="full"]) { margin-block-end');
  });
});

describe('version 16 icon pairing', () => {
  it('pairs an icon with the next block, not with its own instance style element', () => {
    const css = Object.values(BLOCK_TYPE_DEFAULTS_V16).join('\n');
    expect(css).not.toContain('[data-block="icon"] + *');
    expect(css).toContain('> [data-block="icon"] + style + [data-block]');
  });
});
