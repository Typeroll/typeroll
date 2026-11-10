// Heading ids a Page body gets, and the published ones a write changes.
//
// A heading without an explicit id (`anchor_id` on core/heading and
// core/rich_heading, an `id` attribute on a heading in prose or HTML) gets one
// generated from its text when the page renders (heading-outline.ts). Editing
// the text silently changes the id and breaks every inbound `#` link; this
// reports that on the write, instead of pinning ids, which would change how
// existing sites render.
//
// The ids come from prepareHeadingOutline itself, over the body's heading
// sources in document order, so slugs and duplicate suffixes match the
// renderer. Headings that other blocks render (cards, FAQ, templates inside
// the body) are not sources here; they can only shift a duplicate suffix.

import { prepareHeadingOutline } from './heading-outline.js';
import type { Block } from './types.js';

/** One heading of a Page body with the id it renders with. */
export interface HeadingAnchor {
  /** The block that holds the heading; absent for an HTML-mode body. */
  block_id?: string;
  block_type?: string;
  /** Path to the value that sets the id: `data.anchor_id` for heading blocks, `data.html` for prose. */
  path: string;
  /** `block_id#n`: the n-th heading of that block (0 for heading blocks). */
  key: string;
  id: string;
  /** The id is set by the author, not generated from the text. */
  explicit: boolean;
}

export interface HeadingAnchorChangedWarning {
  code: 'heading_anchor_changed';
  block_id?: string;
  block_type?: string;
  /** Where to set the old id to keep inbound links, e.g. `blocks[2].data.anchor_id`. */
  path: string;
  old_id: string;
  new_id: string;
  message: string;
}

const HEADING_RE = /<h([2-4])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;
const ID_RE = /(?<![\w:-])id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HEADING_BLOCKS = new Set(['core/heading', 'core/rich_heading']);
const HTML_BLOCKS = new Set(['core/prose', 'core/html']);

function escapeText(value: string): string {
  return value.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!);
}

function explicitIds(html: string): boolean[] {
  return Array.from(html.matchAll(HEADING_RE), match => {
    const id = match[2]!.match(ID_RE);
    return Boolean((id?.[1] ?? id?.[2] ?? id?.[3] ?? '').trim());
  });
}

interface Source { html: string; block_id?: string; block_type?: string; path: string; explicit: boolean[] }

function blockSources(tree: unknown, root: string, out: Source[], seen: Set<object>): void {
  if (!Array.isArray(tree)) return;
  tree.forEach((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) return;
    seen.add(node);
    const block = node as Block;
    const at = `${root}[${index}]`;
    const data = (block.data && typeof block.data === 'object' ? block.data : {}) as Record<string, unknown>;
    const id = typeof block.id === 'string' && block.id ? block.id : undefined;
    if (HEADING_BLOCKS.has(block.type)) {
      const level = String(data.level ?? 'h2').trim().toLowerCase();
      if (/^h[2-4]$/.test(level)) {
        const anchor = typeof data.anchor_id === 'string' ? data.anchor_id.trim() : '';
        const inner = block.type === 'core/heading' ? escapeText(String(data.text ?? '')) : String(data.html ?? '');
        const attr = anchor ? ` id="${anchor.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"` : '';
        out.push({ html: `<${level}${attr}>${inner}</${level}>`, block_id: id, block_type: block.type, path: `${at}.data.anchor_id`, explicit: [Boolean(anchor)] });
      }
    } else if (HTML_BLOCKS.has(block.type) && typeof data.html === 'string') {
      out.push({ html: data.html, block_id: id, block_type: block.type, path: `${at}.data.html`, explicit: explicitIds(data.html) });
    }
    blockSources(block.children, `${at}.children`, out, seen);
    if (Array.isArray(block.slots)) block.slots.forEach((slot, s) => blockSources(slot, `${at}.slots[${s}]`, out, seen));
  });
}

/** A Page body: its block tree, or the HTML of an HTML-mode page. */
export interface PageBody { content_mode?: unknown; blocks?: unknown; html_content?: unknown }

/** The h2–h4 headings of a Page body with the ids they render with. */
export function headingAnchors(body: PageBody): HeadingAnchor[] {
  const sources: Source[] = [];
  if (body.content_mode === 'html') {
    if (typeof body.html_content !== 'string' || !body.html_content) return [];
    sources.push({ html: body.html_content, path: 'html_content', explicit: explicitIds(body.html_content) });
  } else blockSources(body.blocks, 'blocks', sources, new Set());
  // Each source is checked against the same pattern the outline uses, so the
  // outline's headings split back into their sources in order.
  const { headings } = prepareHeadingOutline(sources.map(source => source.html).join('\n'));
  const out: HeadingAnchor[] = [];
  let next = 0;
  for (const source of sources) {
    source.explicit.forEach((explicit, n) => {
      const heading = headings[next++];
      if (!heading) return;
      out.push({
        ...(source.block_id ? { block_id: source.block_id } : {}),
        ...(source.block_type ? { block_type: source.block_type } : {}),
        path: source.path,
        key: `${source.block_id ?? source.path}#${n}`,
        id: heading.id,
        explicit,
      });
    });
  }
  return out;
}

/**
 * Published heading ids that a write removes from the page because a
 * heading's generated id changed with its text (or position among duplicates).
 *
 * `published` is the body visitors have (the saved, live page), `before` the
 * draft the write started from and `after` the draft it leaves. An id is
 * reported once, by the write that makes it disappear: it is on the
 * published page and in `before`, not in `after`, and the same heading is
 * still there with a generated id. A heading that was deleted, or that now
 * has an explicit id, is the author's choice and not reported.
 */
export function headingAnchorChanges(
  published: PageBody,
  before: PageBody,
  after: PageBody,
): HeadingAnchorChangedWarning[] {
  const live = headingAnchors(published);
  if (!live.length) return [];
  const previous = new Set(headingAnchors(before).map(anchor => anchor.id));
  const next = headingAnchors(after);
  const ids = new Set(next.map(anchor => anchor.id));
  const byKey = new Map(next.map(anchor => [anchor.key, anchor]));
  const out: HeadingAnchorChangedWarning[] = [];
  for (const old of live) {
    if (ids.has(old.id) || !previous.has(old.id)) continue;
    const now = byKey.get(old.key);
    if (!now || now.explicit) continue;
    const where = now.block_id ? `${now.block_type} block ${now.block_id}` : 'the page body';
    const keep = now.path.endsWith('.anchor_id')
      ? `Set ${now.path} to "${old.id}" to keep them.`
      : `Add id="${old.id}" to that heading in ${now.path} to keep them.`;
    out.push({
      code: 'heading_anchor_changed',
      ...(now.block_id ? { block_id: now.block_id } : {}),
      ...(now.block_type ? { block_type: now.block_type } : {}),
      path: now.path,
      old_id: old.id,
      new_id: now.id,
      message: `A heading in ${where} is published with the id "${old.id}" and will get "${now.id}" (an id without anchor_id follows the heading text), so links to #${old.id} stop working. ${keep}`,
    });
  }
  return out;
}
