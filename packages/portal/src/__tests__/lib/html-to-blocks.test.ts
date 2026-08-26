import { describe, it, expect } from 'vitest';
import { htmlToBlocks } from '../../lib/html-to-blocks';

describe('htmlToBlocks — heading detection', () => {
  it('maps <h1>/<h2>/<h3>/<h4> to core/heading with level', () => {
    const r = htmlToBlocks('<h1>Big</h1><h2>Medium</h2><h3>Small</h3>');
    expect(r.blocks).toHaveLength(3);
    expect(r.blocks[0].type).toBe('core/heading');
    expect(r.blocks[0].data.level).toBe('h1');
    expect(r.blocks[0].data.text).toBe('Big');
    expect(r.blocks[1].data.level).toBe('h2');
    expect(r.blocks[2].data.level).toBe('h3');
  });

  it('reads text-center / text-right alignment from class', () => {
    const r = htmlToBlocks('<h2 class="text-center">Centered</h2>');
    expect(r.blocks[0].data.align).toBe('center');
  });
});

describe('htmlToBlocks — image detection', () => {
  it('maps <img> to core/image', () => {
    const r = htmlToBlocks('<img src="/foo.jpg" alt="Foo" />');
    expect(r.blocks[0].type).toBe('core/image');
    expect(r.blocks[0].data.src).toBe('/foo.jpg');
    expect(r.blocks[0].data.alt).toBe('Foo');
  });

  it('unwraps <figure> with <img> + <figcaption>', () => {
    const r = htmlToBlocks(
      '<figure><img src="/bar.jpg" alt="Bar"/><figcaption>A bar</figcaption></figure>',
    );
    expect(r.blocks[0].type).toBe('core/image');
    expect(r.blocks[0].data.caption).toBe('A bar');
  });
});

describe('htmlToBlocks — button detection', () => {
  it('maps <a class="btn"> to core/button', () => {
    const r = htmlToBlocks('<a class="btn btn-primary" href="/buy">Buy now</a>');
    expect(r.blocks[0].type).toBe('core/button');
    expect(r.blocks[0].data.label).toBe('Buy now');
    expect(r.blocks[0].data.href).toBe('/buy');
    expect(r.blocks[0].data.variant).toBe('primary');
  });

  it('detects ghost / outline variant', () => {
    const r = htmlToBlocks('<a class="btn outline" href="/x">X</a>');
    expect(r.blocks[0].data.variant).toBe('ghost');
  });

  it('detects target=_blank as new_tab', () => {
    const r = htmlToBlocks('<a class="btn" href="/y" target="_blank">Y</a>');
    expect(r.blocks[0].data.new_tab).toBe(true);
  });

  it('non-button anchors fall through to prose', () => {
    const r = htmlToBlocks('<a href="/x">Just a link</a>');
    expect(r.blocks[0].type).toBe('core/prose');
  });
});

describe('htmlToBlocks — columns / sections', () => {
  it('maps two-column grid to core/columns', () => {
    const r = htmlToBlocks(
      '<div class="grid grid-cols-2"><p>A</p><p>B</p></div>',
    );
    expect(r.blocks[0].type).toBe('core/columns');
    expect(r.blocks[0].slots).toHaveLength(2);
    expect(r.blocks[0].slots![0]).toHaveLength(1);
    expect(r.blocks[0].slots![1]).toHaveLength(1);
  });

  it('wraps explicit <section> in core/section', () => {
    const r = htmlToBlocks('<section><h2>Title</h2><p>Body</p></section>');
    expect(r.blocks[0].type).toBe('core/section');
    expect(r.blocks[0].children?.length).toBeGreaterThan(0);
  });

  it('treats div.hero as a section', () => {
    const r = htmlToBlocks('<div class="hero"><h1>Hero</h1></div>');
    expect(r.blocks[0].type).toBe('core/section');
  });
});

describe('htmlToBlocks — prose coalescing', () => {
  it('coalesces adjacent prose-y elements into one block', () => {
    const r = htmlToBlocks('<p>First</p><p>Second</p><ul><li>x</li></ul>');
    const proseBlocks = r.blocks.filter((b) => b.type === 'core/prose');
    expect(proseBlocks).toHaveLength(1);
    expect(String(proseBlocks[0].data.html)).toContain('First');
    expect(String(proseBlocks[0].data.html)).toContain('Second');
    expect(String(proseBlocks[0].data.html)).toContain('<li>');
  });

  it('does not coalesce across a heading', () => {
    const r = htmlToBlocks('<p>A</p><h2>Title</h2><p>B</p>');
    expect(r.blocks.map((b) => b.type)).toEqual(['core/prose', 'core/heading', 'core/prose']);
  });
});

describe('htmlToBlocks — fallback + structure', () => {
  it('returns empty result for empty HTML', () => {
    const r = htmlToBlocks('');
    expect(r.blocks).toEqual([]);
  });

  it('handles full-body HTML wrapped in <html>/<body>', () => {
    const r = htmlToBlocks('<html><body><h1>Title</h1></body></html>');
    expect(r.blocks[0].type).toBe('core/heading');
  });

  it('falls back to prose for unknown structural tags', () => {
    const r = htmlToBlocks('<custom-widget>Hi</custom-widget>');
    expect(r.blocks[0].type).toBe('core/prose');
  });

  it('summary counts per block type', () => {
    const r = htmlToBlocks('<h1>A</h1><h2>B</h2><p>P</p>');
    const summary = new Map(r.summary.map((s) => [s.block_type, s.count]));
    expect(summary.get('core/heading')).toBe(2);
    expect(summary.get('core/prose')).toBe(1);
  });
});
