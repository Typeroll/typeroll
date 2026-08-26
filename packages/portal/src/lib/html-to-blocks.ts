// HTML → block-tree conversion (heuristic).
//
// Walks DOM-ish output from htmlparser2 and emits a Block[] using the core
// block library. Best-effort: recognized patterns map to typed core blocks;
// everything else falls through to a `core/prose` block (richtext escape
// hatch). The user can iteratively replace prose blocks with typed ones
// after seeing the result.
//
// Conversion is intentionally simple — Phase 8 ships this so the editor's
// "Convert to blocks" button isn't a dead end, not because we expect
// pixel-perfect fidelity. Authoring shifts to block-mode going forward;
// migration is one-time per page.

import * as htmlparser2 from 'htmlparser2';
import { newBlockId } from './block-mutations';
import type { Block } from '@typeroll/shared';

interface Node {
  type: 'text' | 'tag';
  name?: string;
  attribs?: Record<string, string>;
  children?: Node[];
  data?: string;
}

export interface ConvertResult {
  blocks: Block[];
  /** Summary of recognized patterns, useful for the dry-run preview. */
  summary: Array<{ block_type: string; count: number }>;
  /** Free-form notes — fallbacks taken, content that couldn't be classified
   *  cleanly. Surfaced in the UI's confirmation dialog. */
  notes: string[];
}

/**
 * Convert an HTML body string to a Block[]. The HTML is treated as the
 * inner-body of a page (no <html>/<head> wrapping expected, though the
 * parser tolerates either).
 */
export function htmlToBlocks(html: string): ConvertResult {
  const dom = htmlparser2.parseDocument(html ?? '').children as unknown as Node[];
  const blocks: Block[] = [];
  const counts = new Map<string, number>();
  const notes: string[] = [];

  const topLevel = unwrapTopLevel(dom);

  for (const node of topLevel) {
    const emitted = nodeToBlock(node, notes);
    if (emitted) {
      blocks.push(emitted);
      bump(counts, emitted.type);
    }
  }

  // Coalesce trailing/adjacent prose-like blocks into a single prose block so
  // a page that was just `<h2>+<p>+<p>` becomes one block, not three.
  const coalesced = coalesceProse(blocks, counts);

  return {
    blocks: coalesced,
    summary: Array.from(counts.entries()).map(([block_type, count]) => ({ block_type, count })),
    notes,
  };
}

// ─── Walkers ─────────────────────────────────────────────────────────────

function unwrapTopLevel(nodes: Node[]): Node[] {
  // If the input is wrapped in <html><body>, descend.
  if (nodes.length === 1 && nodes[0].type === 'tag' && nodes[0].name === 'html') {
    const body = nodes[0].children?.find((n) => n.type === 'tag' && n.name === 'body');
    if (body?.children) return body.children;
  }
  // Strip whitespace-only text nodes between top-level elements.
  return nodes.filter((n) => !(n.type === 'text' && (n.data ?? '').trim() === ''));
}

function nodeToBlock(node: Node, notes: string[]): Block | null {
  if (node.type === 'text') {
    const txt = (node.data ?? '').trim();
    if (!txt) return null;
    return prose(`<p>${escapeHtml(txt)}</p>`);
  }

  if (node.type !== 'tag' || !node.name) return null;
  const name = node.name.toLowerCase();

  switch (name) {
    case 'h1': case 'h2': case 'h3': case 'h4':
      return heading(node, name);

    case 'img':
      return image(node);

    case 'a':
      return tryButton(node, notes) ?? prose(serializeInline(node));

    case 'figure':
      return figure(node, notes);

    case 'p':
    case 'ul': case 'ol':
    case 'blockquote':
    case 'pre':
    case 'table':
    case 'hr':
      return prose(serialize(node));

    case 'section':
    case 'div':
      return divOrSection(node, name, notes);
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'aside':
    case 'nav':
      // Unwrap structural tags — we don't have a 1:1 core block for them
      // and they're usually decorative. Their children get classified
      // individually.
      notes.push(`Unwrapped <${name}> — children classified individually.`);
      return null;

    default:
      // Unknown tag: dump as prose with the inner HTML preserved.
      return prose(serialize(node));
  }
}

function heading(node: Node, level: string): Block {
  const text = collectText(node);
  return mkBlock('core/heading', {
    text,
    level,
    align: classToAlign(node) ?? 'left',
    eyebrow: '',
  });
}

function image(node: Node): Block {
  const a = node.attribs ?? {};
  return mkBlock('core/image', {
    src: a.src ?? '',
    alt: a.alt ?? '',
    caption: '',
    link: '',
    width: classToWidth(node) ?? 'normal',
  });
}

function figure(node: Node, notes: string[]): Block | null {
  const img = findFirst(node, 'img');
  const caption = findFirst(node, 'figcaption');
  if (!img) {
    notes.push('<figure> without <img> — falling back to prose.');
    return prose(serialize(node));
  }
  const a = img.attribs ?? {};
  return mkBlock('core/image', {
    src: a.src ?? '',
    alt: a.alt ?? '',
    caption: caption ? collectText(caption) : '',
    link: '',
    width: classToWidth(node) ?? 'normal',
  });
}

function tryButton(node: Node, _notes: string[]): Block | null {
  const a = node.attribs ?? {};
  const cls = (a.class ?? '').toLowerCase();
  if (cls.includes('btn') || cls.includes('button')) {
    const variant: 'primary' | 'secondary' | 'ghost' =
      cls.includes('secondary') ? 'secondary'
      : cls.includes('ghost') || cls.includes('outline') ? 'ghost'
      : 'primary';
    return mkBlock('core/button', {
      label: collectText(node) || 'Learn more',
      href: a.href ?? '#',
      variant,
      size: 'md',
      new_tab: a.target === '_blank',
    });
  }
  return null;
}

function divOrSection(node: Node, name: string, notes: string[]): Block | null {
  const a = node.attribs ?? {};
  const cls = (a.class ?? '').toLowerCase();
  const children = (node.children ?? []).filter(
    (n) => !(n.type === 'text' && (n.data ?? '').trim() === ''),
  );

  // Heuristic: two-column grid → core/columns
  if (cls.includes('grid-cols-2') || cls.match(/\bcol(umn)?s?-2\b/)) {
    const slots = splitIntoSlots(children, 2, notes);
    return mkContainer('core/columns', { ratio: '1-1', gap: 'md', align: 'start' }, {
      slots,
    });
  }

  // Heuristic: hero / banner → wrap children inside a wider section
  const isSection =
    name === 'section' ||
    cls.includes('hero') ||
    cls.includes('section') ||
    cls.includes('banner');

  if (isSection) {
    const inner: Block[] = [];
    for (const c of children) {
      const b = nodeToBlock(c, notes);
      if (b) inner.push(b);
    }
    return mkContainer('core/section', {
      width: 'normal',
      padding_y: 'md',
      background: '',
      text_color: '',
    }, { children: inner });
  }

  // Bare div: dump children at the same level (no wrapper).
  if (cls === '' && (a.id ?? '') === '') {
    // No useful semantic — flatten by re-emitting children as a prose blob.
    return prose(serialize(node));
  }

  // Keep as prose preserving wrapper attributes.
  return prose(serialize(node));
}

function splitIntoSlots(nodes: Node[], slotCount: number, notes: string[]): Block[][] {
  const slots: Block[][] = Array.from({ length: slotCount }, () => []);
  let cursor = 0;
  for (const n of nodes) {
    const b = nodeToBlock(n, notes);
    if (!b) continue;
    slots[Math.min(cursor, slotCount - 1)].push(b);
    cursor = (cursor + 1) % slotCount;
  }
  return slots;
}

// ─── Prose coalescing ────────────────────────────────────────────────────

function coalesceProse(blocks: Block[], counts: Map<string, number>): Block[] {
  const out: Block[] = [];
  let current: { id: string; html: string[] } | null = null;
  for (const b of blocks) {
    if (b.type === 'core/prose') {
      if (current) {
        current.html.push(String(b.data.html ?? ''));
      } else {
        current = { id: b.id, html: [String(b.data.html ?? '')] };
      }
    } else {
      if (current) {
        out.push({
          id: current.id, type: 'core/prose',
          data: { html: current.html.join('\n'), max_width: 'normal' },
        });
        current = null;
      }
      out.push(b);
    }
  }
  if (current) {
    out.push({
      id: current.id, type: 'core/prose',
      data: { html: current.html.join('\n'), max_width: 'normal' },
    });
  }
  // Adjust counts: prose got coalesced — fix the count to reflect the
  // final number actually emitted.
  if (counts.has('core/prose')) {
    counts.set('core/prose', out.filter((b) => b.type === 'core/prose').length);
  }
  return out;
}

// ─── Block builders ──────────────────────────────────────────────────────

function mkBlock(type: string, data: Record<string, unknown>): Block {
  return { id: newBlockId(), type, data };
}

function mkContainer(
  type: string,
  data: Record<string, unknown>,
  rel: { children?: Block[]; slots?: Block[][] },
): Block {
  return {
    id: newBlockId(),
    type,
    data,
    ...(rel.children ? { children: rel.children } : {}),
    ...(rel.slots ? { slots: rel.slots } : {}),
  };
}

function prose(html: string): Block {
  return mkBlock('core/prose', { html, max_width: 'normal' });
}

// ─── DOM helpers ─────────────────────────────────────────────────────────

function findFirst(node: Node, tag: string): Node | null {
  if (!node.children) return null;
  for (const c of node.children) {
    if (c.type === 'tag' && c.name?.toLowerCase() === tag) return c;
    const deep = findFirst(c, tag);
    if (deep) return deep;
  }
  return null;
}

function collectText(node: Node): string {
  if (node.type === 'text') return node.data ?? '';
  if (!node.children) return '';
  return node.children.map(collectText).join('').replace(/\s+/g, ' ').trim();
}

function serialize(node: Node): string {
  // htmlparser2 nodes have a custom shape; render with the official serializer.
  return (htmlparser2 as unknown as {
    DomUtils: { getOuterHTML: (node: unknown) => string };
  }).DomUtils?.getOuterHTML?.(node)
    ?? renderManual(node);
}

function serializeInline(node: Node): string {
  return serialize(node);
}

function renderManual(node: Node): string {
  if (node.type === 'text') return escapeHtml(node.data ?? '');
  if (node.type !== 'tag' || !node.name) return '';
  const attrs = Object.entries(node.attribs ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  const inner = (node.children ?? []).map(renderManual).join('');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

function classToAlign(node: Node): 'left' | 'center' | 'right' | null {
  const c = (node.attribs?.class ?? '').toLowerCase();
  if (c.includes('text-center')) return 'center';
  if (c.includes('text-right')) return 'right';
  if (c.includes('text-left')) return 'left';
  return null;
}

function classToWidth(node: Node): 'narrow' | 'normal' | 'wide' | 'full' | null {
  const c = (node.attribs?.class ?? '').toLowerCase();
  if (c.includes('w-full') || c.includes('full-width')) return 'full';
  if (c.includes('w-wide')) return 'wide';
  if (c.includes('w-narrow')) return 'narrow';
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!),
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
