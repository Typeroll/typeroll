/**
 * Copied blocks on the system clipboard: a JSON text with a marker, so a
 * paste in any Typeroll editor (or an agent through `paste_blocks`) knows it
 * holds blocks and where they came from.
 *
 *   {
 *     "typeroll_clipboard": 1,
 *     "source": { "portal": "https://cms.example.com", "site_id": "studio", "site_key": "…", "page_id": "home" },
 *     "copied_at": "2026-11-07T12:00:00.000Z",
 *     "package": <SitePackage of kind "clipboard">,
 *     "media": [{ "site_id": "studio", "media_id": "…", "addresses": ["https://…/content"] }],
 *     "page_links": { "about": "/about/" },
 *     "text": "Fresh bread\nBaked every morning."
 *   }
 *
 * The package carries the copied blocks (`contents.blocks`) with the styles,
 * site block types (app blocks in their portable `app:` form) and free global
 * blocks they use, so the target site can create what it lacks. Media files
 * are not embedded: the blocks keep their source addresses, and `media` says
 * which library file each address belongs to. Pasting into another site
 * copies a file into that site's Media library only when the person pasting
 * may read the source site; nothing is fetched with other rights.
 *
 * Styles are never mapped to "nearest" styles on paste: they are created on
 * the target site, reused only when identical, and created under a new id
 * (`hero-2`, "Hero (imported)") when the site has a different one.
 *
 * The clipboard holds this JSON as `text/plain`, so pasting into the editor
 * works in every browser. The editor also writes a readable `text/html`
 * flavour (the blocks' text) where the browser allows several flavours, so
 * pasting into a document or an e-mail outside Typeroll gives words, not JSON.
 */
import type { Block } from './types.js';
import { isSitePackage, sitePackageErrors, type SitePackage } from './site-package.js';

export const BLOCK_CLIPBOARD_MARKER = 'typeroll_clipboard';
export const BLOCK_CLIPBOARD_VERSION = 1;
/** The largest clipboard text a paste accepts (bytes of UTF-8). */
export const BLOCK_CLIPBOARD_MAX_BYTES = 2 * 1024 * 1024;
/** Top-level blocks one copy may hold. */
export const BLOCK_CLIPBOARD_MAX_BLOCKS = 200;
const MAX_MEDIA = 500;
const MAX_PAGE_LINKS = 500;

/** A library file the copied blocks use, by the addresses they use for it. */
export interface ClipboardMediaRef {
  site_id: string;
  media_id: string;
  addresses: string[];
  filename?: string;
}

export interface BlockClipboard {
  typeroll_clipboard: typeof BLOCK_CLIPBOARD_VERSION;
  /**
   * Where the blocks were copied. `site_key` is a digest of the site's
   * organization and id, so a paste can tell the same site from another
   * organization's site with the same id without the clipboard naming the
   * organization.
   */
  source: { portal?: string; site_id: string; site_key?: string; page_id?: string };
  copied_at: string;
  package: SitePackage;
  media?: ClipboardMediaRef[];
  /** Addresses of the source site's pages that the blocks link to, by page id. */
  page_links?: Record<string, string>;
  /** The copied blocks' text, for reading. */
  text?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s/]/.test(value);

/** Assemble a clipboard; `text` is derived from the blocks. */
export function buildBlockClipboard(input: Omit<BlockClipboard, 'typeroll_clipboard' | 'text' | 'copied_at'> & { copied_at?: string }): BlockClipboard {
  const blocks = input.package.contents.blocks ?? [];
  const text = blocksPlainText(blocks);
  return {
    typeroll_clipboard: BLOCK_CLIPBOARD_VERSION,
    source: input.source,
    copied_at: input.copied_at ?? new Date().toISOString(),
    package: input.package,
    ...(input.media?.length ? { media: input.media } : {}),
    ...(input.page_links && Object.keys(input.page_links).length ? { page_links: input.page_links } : {}),
    ...(text ? { text } : {}),
  };
}

/** The clipboard as the text that goes on the system clipboard. */
export function serializeBlockClipboard(clipboard: BlockClipboard): string {
  return JSON.stringify(clipboard);
}

/** A cheap check before parsing: does this text look like copied Typeroll blocks? */
export function looksLikeBlockClipboard(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const head = text.trimStart();
  return head.startsWith('{') && head.slice(0, 4096).includes(`"${BLOCK_CLIPBOARD_MARKER}"`);
}

/** Check a clipboard value. Returns the errors; an empty list means it can be pasted. */
export function blockClipboardErrors(input: unknown): string[] {
  if (!isObject(input)) return ['The clipboard must be a JSON object'];
  if (input[BLOCK_CLIPBOARD_MARKER] === undefined) return [`This is not copied Typeroll blocks (no "${BLOCK_CLIPBOARD_MARKER}" marker)`];
  if (input[BLOCK_CLIPBOARD_MARKER] !== BLOCK_CLIPBOARD_VERSION) return [`Clipboard version ${String(input[BLOCK_CLIPBOARD_MARKER])} is not supported (this Core reads ${BLOCK_CLIPBOARD_VERSION})`];
  const errors: string[] = [];
  const source = input.source;
  if (!isObject(source) || !id(source.site_id)) errors.push('source.site_id is required');
  else {
    if (source.page_id !== undefined && !id(source.page_id, 500)) errors.push('source.page_id must be a page id');
    if (source.site_key !== undefined && (typeof source.site_key !== 'string' || !/^[a-f0-9]{16,64}$/.test(source.site_key))) errors.push('source.site_key must be a hex digest');
    if (source.portal !== undefined && (typeof source.portal !== 'string' || !/^https?:\/\/[^\s/]+$/i.test(source.portal))) errors.push('source.portal must be an origin such as https://cms.example.com');
  }
  if (typeof input.copied_at !== 'string' || Number.isNaN(Date.parse(input.copied_at))) errors.push('copied_at must be a date');
  const pkg = input.package;
  if (!isSitePackage(pkg)) errors.push('package must be a Typeroll package of kind "clipboard"');
  else {
    if (pkg.kind !== 'clipboard') errors.push('package.kind must be "clipboard"');
    const blocks = pkg.contents?.blocks;
    if (!Array.isArray(blocks) || !blocks.length) errors.push('package.contents.blocks must hold the copied blocks');
    else if (blocks.length > BLOCK_CLIPBOARD_MAX_BLOCKS) errors.push(`At most ${BLOCK_CLIPBOARD_MAX_BLOCKS} blocks can be pasted at once`);
    if (Array.isArray(pkg.media) && pkg.media.length) errors.push('package.media must be empty: copied blocks keep their media addresses (see "media")');
    if (pkg.fonts?.length) errors.push('package.fonts must be empty: fonts are not copied with blocks');
    for (const key of ['block_templates', 'page_templates', 'pages', 'menus', 'site_fields', 'design', 'site_field_values'] as const) {
      if (pkg.contents && pkg.contents[key] !== undefined) errors.push(`package.contents.${key} is not part of copied blocks`);
    }
    if (!errors.length) errors.push(...sitePackageErrors(pkg).map(error => `package: ${error}`));
  }
  if (input.media !== undefined) {
    if (!Array.isArray(input.media) || input.media.length > MAX_MEDIA) errors.push(`media must be a list of at most ${MAX_MEDIA} files`);
    else for (const entry of input.media) {
      if (!isObject(entry) || !id(entry.site_id) || !id(entry.media_id) || !Array.isArray(entry.addresses) || !entry.addresses.length || entry.addresses.length > 50
        || entry.addresses.some(address => typeof address !== 'string' || !address || address.length > 4096)
        || (entry.filename !== undefined && typeof entry.filename !== 'string')) {
        errors.push('media entries must be { site_id, media_id, addresses: [address, …], filename? }');
        break;
      }
    }
  }
  if (input.page_links !== undefined) {
    if (!isObject(input.page_links) || Object.keys(input.page_links).length > MAX_PAGE_LINKS || Object.values(input.page_links).some(url => typeof url !== 'string' || url.length > 4096)) {
      errors.push(`page_links must map at most ${MAX_PAGE_LINKS} page ids to addresses`);
    }
  }
  if (input.text !== undefined && typeof input.text !== 'string') errors.push('text must be a string');
  return errors;
}

export class BlockClipboardError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: Record<string, unknown>) { super(message); }
}

/**
 * Read a clipboard from its text (or an already parsed object, as an API
 * body may send it). Throws BlockClipboardError when it is too large, not
 * JSON, not copied blocks, or invalid.
 */
export function parseBlockClipboard(input: unknown): BlockClipboard {
  let value = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > BLOCK_CLIPBOARD_MAX_BYTES) {
      throw new BlockClipboardError(`The clipboard holds more than ${BLOCK_CLIPBOARD_MAX_BYTES / 1024 / 1024} MB; copy fewer blocks at a time`, 413, 'clipboard_too_large');
    }
    if (!looksLikeBlockClipboard(input)) throw new BlockClipboardError('The clipboard does not hold copied Typeroll blocks', 400, 'clipboard_invalid');
    try { value = JSON.parse(input); } catch { throw new BlockClipboardError('The clipboard does not hold copied Typeroll blocks (not JSON)', 400, 'clipboard_invalid'); }
  } else if (isObject(input) && new TextEncoder().encode(JSON.stringify(input)).byteLength > BLOCK_CLIPBOARD_MAX_BYTES) {
    throw new BlockClipboardError(`The clipboard holds more than ${BLOCK_CLIPBOARD_MAX_BYTES / 1024 / 1024} MB; copy fewer blocks at a time`, 413, 'clipboard_too_large');
  }
  const errors = blockClipboardErrors(value);
  if (errors.length) throw new BlockClipboardError(`The clipboard cannot be pasted: ${errors[0]}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`, 400, 'clipboard_invalid', { errors: errors.slice(0, 20) });
  return value as BlockClipboard;
}

// ── Text flavours ─────────────────────────────────────────────────────────

const TEXT_KEYS = new Set(['html', 'text', 'title', 'heading', 'subheading', 'eyebrow', 'label', 'caption', 'body', 'content', 'description', 'quote', 'cite', 'question', 'answer', 'summary']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
      if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? match;
    });
}

/** The readable text of a block tree, one line per text field, in reading order. */
export function blocksPlainText(blocks: readonly Block[]): string {
  const lines: string[] = [];
  const scan = (value: unknown, key = '', depth = 0) => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (!TEXT_KEYS.has(key)) return;
      for (const line of stripHtml(value).split('\n')) { const text = line.replace(/\s+/g, ' ').trim(); if (text) lines.push(text); }
    } else if (Array.isArray(value)) value.forEach(item => scan(item, key === 'items' ? '' : key, depth + 1));
    else if (isObject(value)) for (const [inner, child] of Object.entries(value)) scan(child, inner, depth + 1);
  };
  const walk = (list: readonly Block[] | undefined, depth = 0) => {
    if (!Array.isArray(list) || depth > 64) return;
    for (const block of list) {
      if (!block || typeof block !== 'object') continue;
      scan(block.data ?? {});
      walk(block.children, depth + 1);
      for (const slot of block.slots ?? []) walk(slot, depth + 1);
    }
  };
  walk(blocks);
  return lines.join('\n').slice(0, 100_000);
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The `text/html` flavour: the blocks' text as paragraphs. */
export function blockClipboardHtml(clipboard: Pick<BlockClipboard, 'text'>): string {
  const paragraphs = (clipboard.text ?? '').split('\n').filter(Boolean).map(line => `<p>${escapeHtml(line)}</p>`);
  return `<meta charset="utf-8"><div>${paragraphs.join('')}</div>`;
}

/** How many blocks a clipboard holds, nested ones included. */
export function blockClipboardCount(clipboard: Pick<BlockClipboard, 'package'>): { top: number; total: number } {
  const count = (list: readonly Block[] | undefined, depth = 0): number => !Array.isArray(list) || depth > 64 ? 0
    : list.reduce((sum, block) => sum + 1 + count(block.children, depth + 1) + (block.slots ?? []).reduce((n: number, slot: Block[]) => n + count(slot, depth + 1), 0), 0);
  const blocks = clipboard.package.contents.blocks ?? [];
  return { top: blocks.length, total: count(blocks) };
}
