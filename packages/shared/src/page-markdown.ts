// Markdown rendition of a published Page, for AI agents and answer engines.
//
// Each indexable page is also published at `<path>index.md` and linked from
// `llms.txt`. The Markdown comes from the page's own blocks and public fields,
// not from the rendered HTML: it carries the words, links, images, lists,
// tables and questions, and leaves out layout, decoration, navigation, forms
// and scripts. Header and footer partials are not part of it.

import type { Block, ContentType, Page } from './types.js';

export interface PageMarkdownOptions {
  /** Absolute URL of the page; relative links and images resolve against it. */
  url: string;
  /** The page's content type, for its public field labels. */
  contentType?: ContentType;
}

const SKIPPED_BLOCKS = new Set([
  'core/divider', 'core/spacer', 'core/icon', 'core/navigation', 'core/navigation_menu', 'core/search',
  'core/form', 'core/html', 'core/embed', 'core/table_of_contents', 'core/global_block', 'core/logo_cloud',
  'core/logo_item',
]);

/** Data keys read as a short title, in priority order. */
const TITLE_KEYS = ['heading', 'title', 'name'];
/** Data keys read as body text (plain or HTML), in order. */
const BODY_KEYS = ['subheading', 'subtitle', 'description', 'text', 'body', 'bio', 'content', 'quote', 'html', 'caption'];
/** Label/URL pairs rendered as links. */
const LINK_PAIRS: Array<[string, string]> = [['label', 'href'], ['primary_label', 'primary_url'], ['secondary_label', 'secondary_url'], ['cta_label', 'cta_href'], ['link_label', 'link']];
/** Arrays of repeated items rendered one after another. */
const ITEM_KEYS = ['items', 'plans', 'features', 'steps', 'members'];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function absolute(href: string, base: string): string {
  const value = href.trim();
  if (!value || /^(?:javascript|data|vbscript):/i.test(value)) return '';
  if (value.startsWith('#') || /^(?:mailto|tel):/i.test(value)) return value;
  try { return new URL(value, base).href; } catch { return ''; }
}

function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function squash(text: string): string {
  return text.replace(/[ \t\r\f\v\n]+/g, ' ');
}

interface Node { tag: string; attrs: Record<string, string>; children: Array<Node | string> }

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'param', 'track']);
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'button', 'select', 'textarea', 'nav']);

function parseHtml(html: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [] };
  const stack: Node[] = [root];
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  for (const match of html.matchAll(pattern)) {
    const [, closing, rawTag, rawAttrs, selfClosing, text] = match;
    const current = stack[stack.length - 1]!;
    if (text !== undefined) { current.children.push(decodeHtmlEntities(text)); continue; }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const index = stack.map(node => node.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of (rawAttrs ?? '').matchAll(/([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g)) {
      attrs[attr[1]!.toLowerCase()] = decodeHtmlEntities(attr[3] ?? attr[4] ?? attr[2] ?? '');
    }
    const node: Node = { tag, attrs, children: [] };
    current.children.push(node);
    if (!VOID.has(tag) && !selfClosing) stack.push(node);
  }
  return root;
}

function inline(node: Node | string, base: string): string {
  if (typeof node === 'string') return escapeText(squash(node));
  if (DROPPED.has(node.tag)) return '';
  const inner = () => node.children.map(child => inline(child, base)).join('');
  switch (node.tag) {
    case 'br': return '  \n';
    case 'strong': case 'b': { const text = inner().trim(); return text ? `**${text}**` : ''; }
    case 'em': case 'i': { const text = inner().trim(); return text ? `*${text}*` : ''; }
    case 'code': return `\`${node.children.map(child => typeof child === 'string' ? child : '').join('').replace(/`/g, "'")}\``;
    case 'a': {
      const text = inner().trim();
      const href = absolute(node.attrs.href ?? '', base);
      return href && text ? `[${text}](${href})` : text;
    }
    case 'img': {
      const src = absolute(node.attrs.src ?? '', base);
      return src ? `![${escapeText(node.attrs.alt ?? '')}](${src})` : '';
    }
    default: return inner();
  }
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'blockquote', 'ul', 'ol', 'li', 'table', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'details', 'summary', 'dl', 'dt', 'dd']);

function blocks(node: Node, base: string, depth = 0): string[] {
  const out: string[] = [];
  let buffer = '';
  const flush = () => { const text = buffer.replace(/[ \t]+\n/g, '\n').trim(); if (text) out.push(text); buffer = ''; };
  for (const child of node.children) {
    if (typeof child === 'string' || !BLOCK_TAGS.has(child.tag)) { buffer += inline(child, base); continue; }
    flush();
    const tag = child.tag;
    if (/^h[1-6]$/.test(tag)) {
      const text = inline(child, base).trim();
      if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
    } else if (tag === 'ul' || tag === 'ol') {
      let index = Number(child.attrs.start) || 1;
      const items = child.children.filter((item): item is Node => typeof item !== 'string' && item.tag === 'li').map(item => {
        const marker = tag === 'ol' ? `${index++}.` : '-';
        const body = blocks(item, base, depth + 1).join('\n\n').replace(/\n/g, '\n   ');
        return `${'   '.repeat(0)}${marker} ${body}`;
      }).filter(item => item.trim().length > 2);
      if (items.length) out.push(items.join('\n'));
    } else if (tag === 'blockquote') {
      const text = blocks(child, base, depth).join('\n\n');
      if (text) out.push(text.split('\n').map(line => `> ${line}`).join('\n'));
    } else if (tag === 'pre') {
      const text = textOf(child).replace(/\n+$/, '');
      if (text) out.push('```\n' + text + '\n```');
    } else if (tag === 'table') {
      const table = htmlTable(child, base);
      if (table) out.push(table);
    } else if (tag === 'hr') {
      out.push('---');
    } else {
      out.push(...blocks(child, base, depth));
    }
  }
  flush();
  return out;
}

function textOf(node: Node | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}

function htmlTable(table: Node, base: string): string {
  const rows: string[][] = [];
  let header = false;
  const walk = (node: Node) => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'tr') {
        const cells = child.children.filter((cell): cell is Node => typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th'));
        if (!rows.length && cells.length && cells.every(cell => cell.tag === 'th')) header = true;
        rows.push(cells.map(cell => blocks(cell, base).join(' ').replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
      } else if (child.tag !== 'caption') walk(child);
    }
  };
  walk(table);
  return markdownTable(rows, header);
}

function markdownTable(rows: string[][], header: boolean): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map(row => row.length));
  if (!width) return '';
  const pad = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
  const [head, ...body] = header ? rows : [Array.from({ length: width }, () => ''), ...rows];
  return [pad(head!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(pad)].join('\n');
}

/** Convert an HTML fragment (richtext field, prose block) to Markdown. */
export function htmlToMarkdown(html: string, base = 'https://example.invalid/'): string {
  return blocks(parseHtml(html), base).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function textValue(value: unknown, base: string): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return /<[a-z][\s\S]*>/i.test(text) ? htmlToMarkdown(text, base) : escapeText(squash(decodeHtmlEntities(text)));
}

function headingLevel(value: unknown, fallback: number): number {
  const level = typeof value === 'number' ? value : Number(String(value ?? '').replace(/^h/i, ''));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : fallback;
}

function bind(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  return value.replace(/\{\{\{?\s*page\.([\w.]+)\s*\}?\}\}/g, (_, key: string) => {
    const resolved = key.split('.').reduce<unknown>((current, part) => current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, values);
    return typeof resolved === 'string' || typeof resolved === 'number' ? String(resolved) : '';
  }).replace(/\{\{\{?[^}]*\}?\}\}/g, '');
}

interface Context { base: string; values: Record<string, unknown>; level: number }

function itemMarkdown(data: Record<string, unknown>, context: Context): string[] {
  const out: string[] = [];
  const get = (key: string) => bind(data[key], context.values);
  const title = TITLE_KEYS.map(key => textValue(get(key), context.base)).find(Boolean);
  if (title) out.push(`${'#'.repeat(Math.min(context.level, 6))} ${title.replace(/\n+/g, ' ')}`);
  for (const key of ['price', 'period', 'role', 'company']) {
    const value = textValue(get(key), context.base);
    if (value) out.push(value);
  }
  for (const key of BODY_KEYS) {
    const value = textValue(get(key), context.base);
    if (value) out.push(value);
  }
  const image = typeof get('image') === 'string' ? get('image') as string : typeof get('src') === 'string' ? get('src') as string : '';
  const src = image ? absolute(image, context.base) : '';
  if (src) out.push(`![${escapeText(String(get('image_alt') ?? get('alt') ?? ''))}](${src})`);
  for (const [labelKey, urlKey] of LINK_PAIRS) {
    const label = textValue(get(labelKey), context.base);
    const url = typeof get(urlKey) === 'string' ? absolute(get(urlKey) as string, context.base) : '';
    if (label && url) out.push(`[${label}](${url})`);
  }
  for (const key of ITEM_KEYS) {
    const items = data[key];
    if (!Array.isArray(items)) continue;
    const rendered = items.map(item => {
      if (typeof item === 'string') return `- ${textValue(item, context.base)}`;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      if (key === 'features' && typeof record.text === 'string') return `- ${record.included === false ? '~~' + textValue(record.text, context.base) + '~~' : textValue(record.text, context.base)}`;
      return itemMarkdown(record, { ...context, level: context.level + 1 }).join('\n\n');
    }).filter(Boolean);
    if (rendered.length) out.push(rendered.join(key === 'features' ? '\n' : '\n\n'));
  }
  return out;
}

function blockMarkdown(block: Block, context: Context): string[] {
  if (!block || typeof block !== 'object' || SKIPPED_BLOCKS.has(block.type)) return [];
  if (Array.isArray(block.hidden_on) && block.hidden_on.length >= 3) return [];
  const data = (block.data ?? {}) as Record<string, unknown>;
  const get = (key: string) => bind(data[key], context.values);
  const out: string[] = [];
  switch (block.type) {
    case 'core/heading': case 'core/rich_heading': {
      const text = textValue(get('text') ?? get('html'), context.base) || textValue(get('html'), context.base);
      if (text) out.push(`${'#'.repeat(headingLevel(data.level, 2))} ${text.replace(/\n+/g, ' ')}`);
      const subtitle = textValue(get('subtitle'), context.base);
      if (subtitle) out.push(subtitle);
      break;
    }
    case 'core/prose': case 'core/list': case 'core/text': {
      const text = textValue(get('html') ?? get('text'), context.base);
      if (text) out.push(text);
      break;
    }
    case 'core/image': {
      const src = typeof get('src') === 'string' ? absolute(get('src') as string, context.base) : '';
      if (src) out.push(`![${escapeText(String(get('alt') ?? ''))}](${src})`);
      const caption = textValue(get('caption_html') ?? get('caption'), context.base);
      if (caption) out.push(`*${caption}*`);
      break;
    }
    case 'core/button': {
      const label = textValue(get('label'), context.base);
      const href = typeof get('href') === 'string' ? absolute(get('href') as string, context.base) : '';
      if (label && href) out.push(`[${label}](${href})`);
      break;
    }
    case 'core/table': {
      const rows = Array.isArray(data.rows) ? data.rows as Array<{ cells?: Array<{ html?: string; header?: boolean }> }> : [];
      const cells = rows.map(row => (Array.isArray(row?.cells) ? row.cells : []).map(cell => textValue(bind(cell?.html, context.values), context.base).replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
      const header = rows.length > 0 && Array.isArray(rows[0]?.cells) && rows[0]!.cells!.length > 0 && rows[0]!.cells!.every(cell => cell?.header === true);
      const caption = textValue(get('caption'), context.base);
      if (caption) out.push(`*${caption}*`);
      const table = markdownTable(cells, header);
      if (table) out.push(table);
      break;
    }
    case 'core/accordion': {
      const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
      for (const item of items) {
        const question = textValue(bind(item.title, context.values), context.base);
        const answer = textValue(bind(item.content, context.values), context.base);
        if (question) out.push(`**${question.replace(/\n+/g, ' ')}**`);
        if (answer) out.push(answer);
      }
      break;
    }
    case 'core/video': {
      const url = typeof get('video_url') === 'string' ? absolute(get('video_url') as string, context.base) : '';
      if (url) out.push(`[Video](${url})`);
      break;
    }
    case 'core/field_list': {
      const title = textValue(get('title'), context.base);
      if (title) out.push(`**${title}**`);
      break;
    }
    default:
      out.push(...itemMarkdown(data, { ...context, level: 3 }));
  }
  for (const child of block.children ?? []) out.push(...blockMarkdown(child, context));
  for (const slot of block.slots ?? []) for (const child of slot ?? []) out.push(...blockMarkdown(child, context));
  return out;
}

function fieldText(value: unknown, base: string): string {
  if (typeof value === 'string') return textValue(value, base).replace(/\n+/g, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(item => fieldText(item, base)).filter(Boolean).join(', ');
  return '';
}

/**
 * The Markdown rendition of a page: a title, its description, its public
 * custom fields and the text of its blocks.
 */
export function pageMarkdown(page: Page, options: PageMarkdownOptions): string {
  const base = options.url;
  const values: Record<string, unknown> = { ...(page.fields ?? {}), title: page.title, seo_description: page.seo_description };
  const out: string[] = [`# ${escapeText(squash(page.title ?? '').trim()) || base}`];
  const description = textValue(page.seo_description, base);
  if (description) out.push(`> ${description.replace(/\n+/g, ' ')}`);
  const meta: string[] = [`URL: ${base}`];
  const updated = page.date_updated || page.date_published;
  if (updated) meta.push(`Updated: ${String(updated).slice(0, 10)}`);
  if (page.language) meta.push(`Language: ${page.language}`);
  out.push(meta.join('  \n'));
  const fields = (options.contentType?.fields ?? []).filter(field => field.rendered !== false && field.type !== 'richtext');
  const fieldLines = fields.flatMap(field => {
    const value = fieldText(page.fields?.[field.name], base);
    return value && !/^https?:\/\//.test(value) ? [`- **${escapeText(field.label ?? field.name)}:** ${value}`] : [];
  });
  if (fieldLines.length) out.push(fieldLines.join('\n'));
  for (const field of (options.contentType?.fields ?? []).filter(field => field.rendered !== false && field.type === 'richtext')) {
    const value = textValue(page.fields?.[field.name], base);
    if (value) out.push(value);
  }
  if (page.content_mode !== 'html') {
    for (const block of page.blocks ?? []) out.push(...blockMarkdown(block, { base, values, level: 3 }));
  } else if (typeof page.html_content === 'string') {
    const html = htmlToMarkdown(page.html_content, base);
    if (html) out.push(html);
  }
  // Repeated headings next to each other (a hero repeating the page title).
  const deduped = out.filter((part, index) => index === 0 || part.replace(/^#+\s*/, '') !== out[0]!.replace(/^#+\s*/, '') || !/^#/.test(part));
  return `${deduped.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
