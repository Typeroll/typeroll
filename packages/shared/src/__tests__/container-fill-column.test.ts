import { expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlock } from '../index.js';

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
