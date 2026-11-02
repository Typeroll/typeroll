import { expect, it } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlock } from '../index.js';

const registry = buildCoreBlockRegistry();
const outer = (direction: unknown, renderVersion: number) => renderBlock({ id: 'outer', type: 'core/container', data: { direction, width: 'full' },
  children: [{ id: 'inner', type: 'core/container', data: { width: 'wide', max_width_px: 1120 } }] } as never, { registry, renderVersion }).match(/<div[^>]*data-block="container"[^>]*>/)![0];

it('marks a container that is a column at every breakpoint from render version 12 only', () => {
  expect(outer('column', 12)).toContain('data-column-only="true"');
  expect(outer(undefined, 12)).toContain('data-column-only="true"');
  expect(outer({ mobile: 'column', laptop: 'column' }, 12)).toContain('data-column-only="true"');
  expect(outer('row', 12)).not.toContain('data-column-only');
  expect(outer({ mobile: 'column', laptop: 'row' }, 12)).not.toContain('data-column-only');
  expect(outer('column', 11)).not.toContain('data-column-only');
});

it('keeps a column-only container on one flex line from render version 13 only', () => {
  const css = (type: string, renderVersion: number) => collectBlockAssets([{ id: 'b', type, data: {} } as never], registry, { renderVersion }).css;
  const nowrap = '[data-block="container"][data-column-only="true"] { flex-wrap:nowrap; }';
  expect(css('core/container', 13)).toContain(nowrap);
  expect(css('core/container', 12)).not.toContain(nowrap);
  // Text breaks a word that does not fit, so its minimum width stays small.
  expect(css('core/prose', 13)).toContain('[data-block="prose"] :is(p, li, dt, dd, blockquote, figcaption, h1, h2, h3, h4, h5, h6) { overflow-wrap: anywhere; }');
  expect(css('core/prose', 12)).not.toContain(':is(p, li');
  expect(css('core/heading', 13)).toContain('[data-block="heading"] :is(.block-heading-text, .block-heading-eyebrow, .block-heading-subtitle) { overflow-wrap: anywhere; }');
});
