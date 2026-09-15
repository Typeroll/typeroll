// HTML conversion preserves content and reports explicit HTML exceptions.

import * as htmlparser2 from 'htmlparser2';
import { newBlockId } from './block-mutations';
import type { Block } from '@typeroll/shared';

interface Node {
  type: 'text' | 'tag' | 'script' | 'style';
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

  blocks.push(...convertNodes(normalizeLazyMedia(unwrapTopLevel(dom)), notes));
  const coalesced = coalesceProse(blocks, counts);
  const countTree = (tree: Block[]) => {
    for (const block of tree) {
      bump(counts, block.type);
      countTree(block.children ?? []);
      for (const slot of block.slots ?? []) countTree(slot);
    }
  };
  counts.clear();
  countTree(coalesced);
  return {
    blocks: coalesced,
    summary: Array.from(counts.entries()).map(([block_type, count]) => ({ block_type, count })),
    notes,
  };
}

/** Restore lazy media and drop a fallback only when the same media is present. */
function normalizeLazyMedia(nodes: Node[]): Node[] {
  nodes = nodes.map(node => {
    if (node.name === 'img' && node.attribs?.['data-lazy-type'] === 'iframe') {
      const restored = htmlparser2.parseDocument(node.attribs['data-lazy-src'] ?? '').children as unknown as Node[];
      if (restored.length === 1 && restored[0].name === 'iframe') return restored[0];
    }
    return { ...node, ...(node.children ? { children: normalizeLazyMedia(node.children) } : {}) };
  });
  const imageSource = (node: Node) => node.attribs?.['data-lazy-src'] || node.attribs?.['data-src'] || node.attribs?.src || '';
  const imageSources = (node: Node): string[] => node.name === 'noscript' ? []
    : ['img', 'iframe'].includes(node.name ?? '') ? [node.name + ':' + imageSource(node)] : (node.children ?? []).flatMap(imageSources);
  const present = new Set(nodes.flatMap(imageSources));
  return nodes.flatMap(node => {
    if (node.name === 'noscript') {
      const children = node.children ?? [];
      const images = children.filter(child => ['img', 'iframe'].includes(child.name ?? ''));
      const onlyImages = children.every(child => ['img', 'iframe'].includes(child.name ?? '') || (child.type === 'text' && !child.data?.trim()));
      if (onlyImages && images.length && images.every(image => present.has(image.name + ':' + imageSource(image)))) return [];
      if (onlyImages && images.length) return images;
    }
    return [node];
  });
}

function convertNodes(nodes: Node[], notes: string[]): Block[] {
  return nodes.flatMap(node => {
    const name = node.name?.toLowerCase();
    // Keep meaningful wrapper attributes and semantics while making every
    // child independently editable. Unstyled divs can be flattened safely.
    if (node.type === 'tag' && ['html', 'body'].includes(name ?? '')) return convertNodes(node.children ?? [], notes);
    if (node.type === 'tag' && ['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav'].includes(name ?? '')) {
      const attributes = node.attribs ?? {};
      const heuristic = /^(?:grid |grid-cols-2|hero|banner|section|cols?-2)/i.test(attributes.class ?? '') && !attributes.style && !attributes.id;
      if (!heuristic && (Object.keys(attributes).length || !['div', 'section'].includes(name!))) {
        const unknown = Object.keys(attributes).filter(key => !['class', 'id', 'style', 'aria-label'].includes(key));
        if (unknown.some(key => !/^(?:data-[a-z0-9_-]+|aria-[a-z0-9_-]+|role|itemscope|itemtype|itemprop|lang|dir|hidden|title)$/.test(key))) return [exception(node, notes)];
        return [mkContainer('core/container', {
          tag: name, layout: 'flow', css_class: attributes.class ?? '', html_id: attributes.id ?? '',
          inline_style: attributes.style ?? '', aria_label: attributes['aria-label'] ?? '',
          attributes: unknown.map(name => ({ name, value: attributes[name] })),
        }, { children: convertNodes(node.children ?? [], notes) })];
      }
      if (name === 'div' && !heuristic) return convertNodes(node.children ?? [], notes);
    }
    // Split images/videos out of mixed paragraphs rather than burying them in prose.
    if (['p', 'span'].includes(name ?? '') && (findFirst(node, 'img') || findFirst(node, 'iframe'))) {
      const output: Block[] = [];
      let inline: Node[] = [];
      const flush = () => {
        if (inline.length) output.push(prose(`<p>${inline.map(serialize).join('')}</p>`));
        inline = [];
      };
      for (const child of node.children ?? []) {
        if (['img', 'iframe'].includes(child.name ?? '') || (child.name === 'a' && findFirst(child, 'img'))) {
          flush(); output.push(...convertNodes([child], notes));
        } else inline.push(child);
      }
      flush();
      return output;
    }
    const block = nodeToBlock(node, notes);
    if (block && node.attribs?.id && !name?.match(/^h[1-6]$/)) {
      block.style_overrides = { ...block.style_overrides, html_id: node.attribs.id };
    }
    return block ? [block] : [];
  });
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

  if (node.type === 'script' || node.type === 'style') return exception(node, notes);
  if (node.type !== 'tag' || !node.name) return null;
  const name = node.name.toLowerCase();

  switch (name) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return (node.children ?? []).some(child => child.type === 'tag')
        ? mkBlock('core/rich_heading', { html: innerHtml(node), level: name, anchor_id: node.attribs?.id ?? '', align: classToAlign(node) ?? 'left' })
        : heading(node, name);

    case 'img':
      return image(node);

    case 'a':
      if (findFirst(node, 'img')) { const b = figure(node, notes)!; b.data.link = node.attribs?.href ?? ''; return b; }
      return tryButton(node, notes) ?? prose(serializeInline(node));

    case 'figure': case 'picture':
      return figure(node, notes);

    case 'ul': case 'ol':
      return mkBlock('core/list', { ordered: name === 'ol', start: Number(node.attribs?.start ?? 1),
        items: (node.children ?? []).filter(n => n.name === 'li').map(n => ({ html: innerHtml(n) })) });
    case 'table':
      return table(node);
    case 'iframe': {
      const src = node.attribs?.src ?? '';
      if (/^https?:\/\/(www\.)?(youtube(-nocookie)?\.com|player\.vimeo\.com)\//.test(src))
        return mkBlock('core/video', { video_url: src, source: src.includes('vimeo') ? 'vimeo' : 'youtube', aspect_ratio: '16:9', title: node.attribs?.title ?? 'Video' });
      return exception(node, notes);
    }
    case 'span': case 'strong': case 'em': case 'b': case 'i': case 'small': case 'br': case 'u':
    case 'p':

    case 'blockquote':
    case 'pre':

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
      return exception(node, notes);
  }
}

function heading(node: Node, level: string): Block {
  const text = collectText(node);
  return mkBlock('core/heading', {
    text,
    size: 'theme',
    anchor_id: node.attribs?.id ?? '',
    level,
    align: classToAlign(node) ?? 'left',
    eyebrow: '',
  });
}

function image(node: Node): Block {
  const a = node.attribs ?? {};
  return mkBlock('core/image', {
    src: a['data-lazy-src'] || a['data-src'] || a.src || '',
    alt: a.alt ?? '',
    caption: '',
    link: '',
    width: classToWidth(node) ?? (a.width ? 'original' : 'normal'),
    original_width: Number(a.width) || undefined,
    original_height: Number(a.height) || undefined,
    align: (a.class ?? '').includes('alignleft') ? 'left' : (a.class ?? '').includes('alignright') ? 'right' : 'center',
    caption_align: 'left',
  });
}

function figure(node: Node, notes: string[]): Block | null {
  const embeddedTable = findFirst(node, 'table');
  if (embeddedTable && (node.children ?? []).every(child => child.type === 'text' || child === embeddedTable || child.name === 'figcaption')) {
    const block = table(embeddedTable);
    const caption = findFirst(node, 'figcaption');
    if (caption) block.data.source = innerHtml(caption);
    return block;
  }
  const images = (current: Node): number => (current.name === 'img' ? 1 : 0) + (current.children ?? []).reduce((sum, child) => sum + images(child), 0);
  if (images(node) > 1) return exception(node, notes);
  const img = findFirst(node, 'img');
  const caption = findFirst(node, 'figcaption');
  if (!img) {
    const video = findFirst(node, 'iframe');
    return video ? nodeToBlock(video, notes) : exception(node, notes);
  }
  const block = image(img);
  block.data.caption = caption ? collectText(caption) : '';
  block.data.caption_html = caption ? innerHtml(caption) : '';
  const imageLink = (current: Node): Node | undefined => current.name === 'a' && findFirst(current, 'img') ? current : (current.children ?? []).map(imageLink).find(Boolean);
  block.data.link = imageLink(node)?.attribs?.href ?? '';
  const source = findFirst(node, 'source');
  if (source?.attribs?.media?.includes('max-width')) block.data.mobile_src = source.attribs.srcset?.split(/[ ,]/)[0] ?? '';
  return block;
}

function innerHtml(node: Node): string { return (node.children ?? []).map(serialize).join(''); }

function exception(node: Node, notes: string[]): Block {
  const reason = `Review <${node.name ?? 'unknown'}> integration or unsupported markup before publishing.`;
  notes.push(reason);
  return { ...mkBlock('core/html', { html: serialize(node) }), name: `Imported ${node.name ?? 'HTML'} — review` };
}

function table(node: Node): Block {
  const descendants = (n: Node, tag: string): Node[] => (n.children ?? []).flatMap(c => c.name === tag ? [c] : descendants(c, tag));
  const styleValue = (n: Node, property: string): string => (n.attribs?.style ?? '').split(';')
    .map(part => part.split(':')).find(([key]) => key.trim() === property)?.slice(1).join(':').trim() ?? '';
  return mkBlock('core/table', {
    caption: findFirst(node, 'caption') ? innerHtml(findFirst(node, 'caption')!) : '',
    borders: 'all', density: 'normal',
    rows: descendants(node, 'tr').map(row => ({ cells: (row.children ?? []).filter(c => c.name === 'td' || c.name === 'th').map(cell => ({
      html: innerHtml(cell), header: cell.name === 'th',
      colspan: Number(cell.attribs?.colspan ?? 1), rowspan: Number(cell.attribs?.rowspan ?? 1),
      align: styleValue(cell, 'text-align') || cell.attribs?.align || 'left',
      background: styleValue(cell, 'background-color') || cell.attribs?.bgcolor || '',
      color: styleValue(cell, 'color'), width: styleValue(cell, 'width'),
    })) })),
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
    const inner = convertNodes(children, notes);
    return mkContainer('core/section', {
      width: 'normal',
      padding_y: 'none',
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
    const blocks = convertNodes([n], notes);
    if (!blocks.length) continue;
    slots[Math.min(cursor, slotCount - 1)].push(...blocks);
    cursor = (cursor + 1) % slotCount;
  }
  return slots;
}

// ─── Prose coalescing ────────────────────────────────────────────────────

function coalesceProse(blocks: Block[], counts: Map<string, number>): Block[] {
  const out: Block[] = [];
  let current: { id: string; html: string[] } | null = null;
  for (const b of blocks) {
    if (b.type === 'core/prose' && !b.style_overrides) {
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
