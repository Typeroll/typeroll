// Generated heading ids change with the heading text (Moveria: editing a
// published heading broke inbound `#` links without notice). The write
// reports it as `heading_anchor_changed`; rendering is unchanged.

import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlocks } from '../render-blocks.js';
import { prepareHeadingOutline } from '../heading-outline.js';
import { headingAnchorChanges, headingAnchors, type Block } from '../index.js';

const registry = buildCoreBlockRegistry();
const body = (blocks: Block[]) => ({ content_mode: 'blocks', blocks });

const tree = (): Block[] => [
  { id: 'a', type: 'core/heading', data: { text: 'Verhuizen & opslag', level: 'h2' } },
  { id: 's', type: 'core/section', data: {}, children: [
    { id: 'b', type: 'core/rich_heading', data: { html: 'Kosten <em>berekenen</em>', level: 'h3' } },
    { id: 'p', type: 'core/prose', data: { html: '<h2>Verhuizen &amp; opslag</h2><p>x</p><h3 id="faq">Vragen</h3><h5>Klein</h5>' } },
  ] },
  { id: 'c', type: 'core/heading', data: { text: 'Contact', level: 'h2', anchor_id: 'bel-ons' } },
  { id: 'd', type: 'core/heading', data: { text: 'Titel', level: 'h1' } },
];

describe('headingAnchors', () => {
  it('gives the ids the renderer gives, in document order', () => {
    const anchors = headingAnchors(body(tree()));
    expect(anchors.map(anchor => [anchor.key, anchor.id, anchor.explicit])).toEqual([
      ['a#0', 'verhuizen-opslag', false],
      ['b#0', 'kosten-berekenen', false],
      ['p#0', 'verhuizen-opslag-2', false],
      ['p#1', 'faq', true],
      ['c#0', 'bel-ons', true],
    ]);
    const rendered = prepareHeadingOutline(renderBlocks(tree(), { registry })).headings.map(heading => heading.id);
    expect(anchors.map(anchor => anchor.id)).toEqual(rendered);
  });

  it('reads the HTML of an HTML-mode page', () => {
    expect(headingAnchors({ content_mode: 'html', html_content: '<h2>Prijzen</h2>', blocks: [] }).map(anchor => [anchor.key, anchor.path, anchor.id]))
      .toEqual([['html_content#0', 'html_content', 'prijzen']]);
  });
});

describe('headingAnchorChanges', () => {
  it('reports a published generated id that the text change removes', () => {
    const published = tree();
    const after = tree();
    after[1]!.children![0]!.data.html = 'Kosten <em>vergelijken</em>';
    expect(headingAnchorChanges(body(published), body(published), body(after))).toEqual([{
      code: 'heading_anchor_changed',
      block_id: 'b',
      block_type: 'core/rich_heading',
      path: 'blocks[1].children[0].data.anchor_id',
      old_id: 'kosten-berekenen',
      new_id: 'kosten-vergelijken',
      message: 'A heading in core/rich_heading block b is published with the id "kosten-berekenen" and will get "kosten-vergelijken" (an id without anchor_id follows the heading text), so links to #kosten-berekenen stop working. Set blocks[1].children[0].data.anchor_id to "kosten-berekenen" to keep them.',
    }]);
  });

  it('points prose headings at their HTML', () => {
    const after = tree();
    after[1]!.children![1]!.data.html = '<h2>Opslag</h2><p>x</p><h3 id="faq">Vragen</h3>';
    expect(headingAnchorChanges(body(tree()), body(tree()), body(after))).toEqual([expect.objectContaining({
      block_id: 'p', path: 'blocks[1].children[1].data.html', old_id: 'verhuizen-opslag-2', new_id: 'opslag',
      message: expect.stringContaining('Add id="verhuizen-opslag-2" to that heading in blocks[1].children[1].data.html'),
    })]);
  });

  it('is quiet when the id is kept, explicit, deleted or already changed by an earlier write', () => {
    const published = tree();
    const kept = tree();
    kept[0]!.data = { ...kept[0]!.data, text: 'Nieuwe tekst', anchor_id: 'verhuizen-opslag' };
    expect(headingAnchorChanges(body(published), body(published), body(kept))).toEqual([]);

    const explicit = tree();
    explicit[2]!.data.text = 'Bel ons nu';
    expect(headingAnchorChanges(body(published), body(published), body(explicit))).toEqual([]);

    const deleted = tree().filter(block => block.id !== 'a');
    // The prose heading now takes the unsuffixed id; its own old id is gone with the duplicate.
    expect(headingAnchorChanges(body(published), body(published), body(deleted)).map(warning => warning.old_id)).toEqual(['verhuizen-opslag-2']);

    const first = tree();
    first[0]!.data.text = 'Opslag';
    const second = structuredClone(first);
    second[3]!.data.text = 'Andere titel';
    expect(headingAnchorChanges(body(published), body(first), body(second))).toEqual([]);
  });

  it('is quiet when a reverted heading gets its published id back', () => {
    const edited = tree();
    edited[0]!.data.text = 'Opslag';
    expect(headingAnchorChanges(body(tree()), body(edited), body(tree()))).toEqual([]);
  });

  it('has nothing to report for a page without published headings', () => {
    expect(headingAnchorChanges(body([]), body([]), body(tree()))).toEqual([]);
  });
});
