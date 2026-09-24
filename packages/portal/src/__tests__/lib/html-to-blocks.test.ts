import { describe, it, expect } from 'vitest';
import { htmlToBlocks } from '../../lib/html-to-blocks';
import { cleanWordPressHtml } from '../../lib/wp/clean-html';

describe('htmlToBlocks — heading detection', () => {
  it('maps <h1>/<h2>/<h3>/<h4> to core/heading with level', () => {
    const r = htmlToBlocks('<h1>Big</h1><h2>Medium</h2><h3>Small</h3>');
    expect(r.blocks).toHaveLength(3);
    expect(r.blocks[0].type).toBe('core/heading');
    expect(r.blocks[0].data.level).toBe('h1');
    expect(r.blocks[0].data.text).toBe('Big');
    expect(r.blocks[1].data.level).toBe('h2');
    expect(r.blocks[1].data.size).toBe('theme');
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
    expect(r.blocks[1]).toMatchObject({ type: 'core/list', data: { items: [{ html: 'x' }] } });
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

  it('names unsupported markup as an HTML exception', () => {
    const r = htmlToBlocks('<custom-widget>Hi</custom-widget>');
    expect(r.blocks[0].type).toBe('core/html');
    expect(r.notes[0]).toContain('custom-widget');
  });

  it('summary counts per block type', () => {
    const r = htmlToBlocks('<h1>A</h1><h2>B</h2><p>P</p>');
    const summary = new Map(r.summary.map((s) => [s.block_type, s.count]));
    expect(summary.get('core/heading')).toBe(2);
    expect(summary.get('core/prose')).toBe(1);
  });
});


describe('content-preserving migration', () => {
  it('preserves nested article containers without losing headings, links or lists', () => {
    const result = htmlToBlocks('<article><div class="entry"><h2 id="old-id">Budget</h2><p>A <a href="/x">link</a></p><ol start="3"><li>First</li></ol></div></article>');
    expect(result.blocks[0]).toMatchObject({ type: 'core/container', data: { tag: 'article' } });
    const entry = result.blocks[0].children![0];
    expect(entry.data.css_class).toBe('entry');
    expect(entry.children!.map(b => b.type)).toEqual(['core/heading', 'core/prose', 'core/list']);
    expect(entry.children![0].data.anchor_id).toBe('old-id');
    expect(entry.children![1].data.html).toContain('href="/x"');
    expect(entry.children![2].data.start).toBe(3);
  });
  it('extracts linked images from paragraphs and retains caption markup', () => {
    const result = htmlToBlocks('<p>Before<a href="/offer"><img src="/photo.jpg" width="400" height="200"></a>After</p><figure><img src="/other.jpg"><figcaption>Credit <a href="/author">Author</a></figcaption></figure>');
    const images = result.blocks.filter(b => b.type === 'core/image');
    expect(images).toHaveLength(2);
    expect(images[0].data).toMatchObject({ link: '/offer', original_width: 400, original_height: 200 });
    expect(images[1].data.caption_html).toContain('href="/author"');
    expect(JSON.stringify(result.blocks)).toContain('Before');
    expect(JSON.stringify(result.blocks)).toContain('After');
  });
  it('preserves table header, colored cells, spans and video embeds as native blocks', () => {
    const result = htmlToBlocks('<table><tr><th colspan="2">Cost</th></tr><tr><td style="background-color:#ff0000">100</td></tr></table><iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(result.blocks[0]).toMatchObject({ type: 'core/table', data: { rows: [
      { cells: [{ header: true, colspan: 2, html: 'Cost' }] },
      { cells: [{ background: '#ff0000', html: '100' }] },
    ] } });
    expect(result.blocks[1]).toMatchObject({ type: 'core/video', data: { video_url: 'https://www.youtube.com/embed/abc' } });
  });
});

it('converts WordPress table figures to editable cells and preserves their source credit', () => {
  const result = htmlToBlocks('<figure class="wp-block-table"><table><tr><th>Price</th><td style="background-color:#ffcc00">100</td></tr></table><figcaption>Source: <a href="/prices">Price list</a></figcaption></figure>');
  expect(result.blocks[0]).toMatchObject({ type: 'core/table', data: { source: 'Source: <a href="/prices">Price list</a>', rows: [{ cells: [{ html: 'Price', header: true }, { html: '100', background: '#ffcc00' }] }] } });
  expect(result.notes).toEqual([]);
});

it('converts linked lazy images and captioned WordPress figures without duplicate noscript images', () => {
  const result = htmlToBlocks('<a href="/offer"><img src="data:image/gif;base64,AA" data-lazy-src="/banner.jpg"><noscript><img src="/banner.jpg"></noscript></a><figure><img src="/photo.jpg" width="300"><noscript><img src="/photo.jpg" width="300"></noscript><figcaption>Photo: <a href="/author">Author</a></figcaption></figure>');
  expect(result.notes).toEqual([]);
  expect(result.blocks).toHaveLength(2);
  expect(result.blocks[0]).toMatchObject({ type: 'core/image', data: { src: '/banner.jpg', link: '/offer' } });
  expect(result.blocks[1]).toMatchObject({ type: 'core/image', data: { src: '/photo.jpg', link: '', caption_html: 'Photo: <a href="/author">Author</a>' } });
});

it('preserves a standalone fallback image and a distinct noscript message', () => {
  const result = htmlToBlocks('<noscript><img src="/only.jpg"></noscript><noscript>Please enable JavaScript</noscript><u>Underlined text</u>');
  expect(result.blocks[0]).toMatchObject({ type: 'core/image', data: { src: '/only.jpg' } });
  expect(JSON.stringify(result.blocks)).toContain('Please enable JavaScript');
  expect(result.blocks.at(-1)).toMatchObject({ type: 'core/prose', data: { html: '<u>Underlined text</u>' } });
});


it('restores a lazy video once as a responsive video block while preserving nearby prose', () => {
  const frame = '<iframe src="https://www.youtube.com/embed/example" width="1200" height="675"></iframe>';
  const encoded = frame.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const result = htmlToBlocks('<span>Before<img data-lazy-type="iframe" data-lazy-src="' + encoded + '"><noscript>' + frame + '</noscript>After</span>');
  expect(result.blocks.map(block => block.type)).toEqual(['core/prose', 'core/video', 'core/prose']);
  expect(result.blocks[1].data.video_url).toBe('https://www.youtube.com/embed/example');
  expect(result.blocks[0].data.html).toContain('Before');
  expect(result.blocks[2].data.html).toContain('After');
  expect(result.notes).toEqual([]);
});

describe('raw WordPress content order', () => {
  it('repairs malformed heading wrappers before serialization and keeps the image in its body position', () => {
    // Minimal source-shaped reproduction: a nested H2 is implicitly closed by browsers.
    const result=htmlToBlocks('<h2 id="first">First<h2 id="second">Second</h2><p>Details</p><h2><img data-lazy-src="/price.jpg" src="/placeholder.gif" width="1000" height="666" alt="Boxes"><noscript><img src="/price.jpg" alt="Boxes"></noscript></h2><h2 id="after">After</h2><a class="btn" href="/quote">Get a quote</a>');
    expect(result.blocks.map(b=>b.type)).toEqual(['core/heading','core/heading','core/prose','core/image','core/heading','core/button']);
    expect(result.blocks[0].data.anchor_id).toBe('first');
    expect(result.blocks[1].data.anchor_id).toBe('second');
    expect(result.blocks[3].data).toMatchObject({src:'/price.jpg',original_width:1000,original_height:666});
    expect(result.blocks[4].data.anchor_id).toBe('after');
  });
  it('preserves ordered headings, media and calls to action through the WordPress sanitizer too', () => {
    const raw='<h2 id="first">First<h2 id="second">Second</h2><p>Details</p><h2><img data-src="https://old.example/price.jpg" src="/placeholder.gif" alt="Boxes"><noscript><img src="https://old.example/price.jpg" alt="Boxes"></noscript></h2><h2 id="related">Related</h2><p><a href="/quote">Request a quote</a></p>';
    const result=htmlToBlocks(cleanWordPressHtml(raw,{mediaMap:new Map([['https://old.example/price.jpg','https://media.example/price.jpg']])}));
    expect(result.blocks.map(b=>b.type)).toEqual(['core/heading','core/heading','core/prose','core/image','core/heading','core/prose']);
    expect(result.blocks[3].data.src).toBe('https://media.example/price.jpg');
    expect(result.blocks[4].data.anchor_id).toBe('related');
    expect(result.blocks[5].data.html).toContain('href="/quote"');
  });
  it('reports text discarded from a link-wrapped card', () => {
    const result = htmlToBlocks('<a class="area-card" href="/podd/"><span class="area-media"><picture><img src="/cover.jpg" alt=""></picture></span><span class="area-body"><h3>Episode title</h3><p>The description that must survive.</p></span></a>');
    expect(result.blocks.map(block => block.type)).toEqual(['core/image']);
    expect(JSON.stringify(result.blocks)).not.toContain('The description that must survive.');
    expect(result.unconverted.map(item => item.source).join('\n')).toContain('The description that must survive.');
    expect(result.unconverted.map(item => item.source).join('\n')).toContain('area-card');
    expect(result.notes.join('\n')).toContain('The description that must survive.');
  });
  it('keeps linked image-only headings as native media, not textual headings or TOC entries', () => {
    const result=htmlToBlocks('<p>Intro</p><h2><a href="/photo.jpg"><img src="/photo.jpg" alt="Photo"></a></h2><h2>Related</h2>');
    expect(result.blocks.map(b=>b.type)).toEqual(['core/prose','core/image','core/heading']);
    expect(result.blocks[1].data.link).toBe('/photo.jpg');
  });
});
