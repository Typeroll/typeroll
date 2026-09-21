// Rendering from data an app derived at build time. The point of the source
// type is that a listing, its counts and the profile beside it all come from
// one accepted revision, instead of from mirrors something else refreshed.

import { describe, it, expect } from 'vitest';
import { renderBlocks, type RenderContext } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();

const listing = (over: Record<string, unknown> = {}): Block => ({
  id: 'r1',
  type: 'core/repeater',
  data: { source_type: 'derived', derived_source: 'directory.profiles', item_block: 'core/heading', ...over },
});

const render = (block: Block, context?: RenderContext) =>
  renderBlocks([block], { registry, context });

describe('derived repeater source', () => {
  it('renders one item per derived record', () => {
    const html = render(listing(), {
      derived: { 'directory.profiles': [{ text: 'Acme' }, { text: 'Lakeside' }] },
    });
    expect(html).toContain('Acme');
    expect(html).toContain('Lakeside');
  });

  it('renders nothing for a source the app produced empty', () => {
    // An empty listing is a real answer — no company matched — and must not
    // read as a failure or fall back to some other source.
    const html = render(listing(), { derived: { 'directory.profiles': [] } });
    expect(html).not.toContain('Acme');
  });

  it('renders empty when no derivation ran at all, rather than breaking the page', () => {
    expect(() => render(listing(), {})).not.toThrow();
    expect(() => render(listing())).not.toThrow();
  });

  it('does not reach a different source than the one named', () => {
    const html = render(listing(), {
      derived: { 'directory.profiles': [{ text: 'Right' }], 'attribution.rules': [{ text: 'Wrong' }] },
    });
    expect(html).toContain('Right');
    expect(html).not.toContain('Wrong');
  });

  it('ignores non-object records instead of rendering them', () => {
    const html = render(listing(), {
      derived: { 'directory.profiles': [{ text: 'Acme' }, null as never, 'nope' as never] },
    });
    expect(html).toContain('Acme');
    expect(html).not.toContain('nope');
  });

  it('honours a limit', () => {
    const html = render(listing({ limit: 1 }), {
      derived: { 'directory.profiles': [{ text: 'First' }, { text: 'Second' }] },
    });
    expect(html).toContain('First');
    expect(html).not.toContain('Second');
  });

  it('renders empty when the block names no source', () => {
    const html = render(listing({ derived_source: '' }), {
      derived: { 'directory.profiles': [{ text: 'Acme' }] },
    });
    expect(html).not.toContain('Acme');
  });
});
