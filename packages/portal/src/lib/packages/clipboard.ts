// Copy and paste of blocks between pages and sites (block-clipboard.ts in
// shared has the clipboard format).
//
// Copy reads blocks from a page's draft and builds a clipboard: a package of
// kind "clipboard" with the blocks and the styles, site block types and free
// global blocks they use (package-export.ts), with media left at their
// addresses and listed with the library file each belongs to.
//
// Paste places a clipboard's blocks in a page's draft, with new ids:
//   - Into the same site, the blocks are placed as they are: their styles,
//     block types, global blocks, media and page links are the site's own.
//   - Into another site, the package is imported first, the way a collection
//     entry is inserted into a page (package-place.ts): styles are created,
//     never mapped to "nearest" ones; one the site has with another
//     definition is created under a new id (hero-2, "Hero (imported)") and
//     the blocks rewritten to it. Block types and global blocks follow the
//     same rule. Links to the source site's pages become plain addresses.
//     Each media file is copied into the target site's Media library (or a
//     file with the same bytes reused) only when the person pasting may read
//     the source site; the route decides that with the same session or key
//     (`sourceAccess`). A private file they cannot read is left out with a
//     warning; nothing is read with other rights.
//
// Copy needs read permission on the source site, paste write permission on
// the target. Creating the styles, block types and global blocks a paste
// needs takes write permission, as the styles and block type routes do.

import { createHash } from 'node:crypto';
import {
  BLOCK_CLIPBOARD_MAX_BLOCKS, BLOCK_CLIPBOARD_MAX_BYTES, BlockClipboardError, buildBlockClipboard, buildCoreBlockRegistry, blockClipboardCount,
  blockClipboardHtml, blockTypeRefs, packageMediaUrl, parseBlockClipboard, paths, rewriteBlockReferences, serializeBlockClipboard, sitePackageErrors,
  type Block, type BlockClipboard, type Media, type PackageMedia, type SitePackage,
} from '@typeroll/shared';
import { replaceReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';
import { getStore } from '../datastore';
import { vstore } from '../version-store';
import { loadDraftTree } from '../page-draft-tree';
import { findBlock } from '../block-mutations';
import { buildSitePackage, detachPageLinks, mediaFileExtension } from './package-export';
import { defaultPackageMediaIO, findMediaBySha, mediaAddresses, type PackageMediaIO } from './package-media';
import { parsePagePosition, placePackageBlocks, type PagePosition, type PlaceCtx } from './package-place';
import type { PackageImportReport, PreparedImport } from './package-import';
import { isRecord } from './package-common';
import { PackageError, packageIntegrity, sha256Hex } from './package-zip';

/** This portal's origin, as copied clipboards name it. */
export function portalOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PORTAL_PUBLIC_URL?.trim();
  if (configured) { try { return new URL(configured).origin; } catch { /* fall back to the request */ } }
  return new URL(request.url).origin;
}

/** A digest of the site's organization and id: tells the same site from another organization's site with that id. */
export const siteKey = (orgId: string, siteId: string) => createHash('sha256').update(`${orgId}/${siteId}`).digest('hex').slice(0, 24);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const invalid = (message: string) => new PackageError(message, 400, 'clipboard_invalid');

function rethrowClipboard(error: unknown): never {
  if (error instanceof BlockClipboardError) throw new PackageError(error.message, error.status, error.code as 'clipboard_invalid' | 'clipboard_too_large', error.details);
  throw error;
}

// ── Copy ──────────────────────────────────────────────────────────────────

export interface CopyCtx { orgId: string; siteId: string; versionId: string; portal: string }

export interface CopyResult {
  clipboard: BlockClipboard;
  /** The clipboard as the text to put on the system clipboard. */
  clipboard_text: string;
  /** A readable `text/html` flavour for pasting outside Typeroll. */
  clipboard_html: string;
  count: { top: number; total: number };
  warnings: string[];
}

/** Check a copy request body: { page_id, block_ids }. */
export function parseCopyRequest(body: unknown): { page_id: string; block_ids: string[] } {
  if (!isRecord(body)) throw invalid('Send { page_id, block_ids: [id, …] }');
  const unknown = Object.keys(body).filter(key => key !== 'page_id' && key !== 'block_ids');
  if (unknown.length) throw invalid(`Unknown fields: ${unknown.join(', ')}. Accepted: page_id, block_ids`);
  if (typeof body.page_id !== 'string' || !body.page_id) throw invalid('page_id is required');
  if (!Array.isArray(body.block_ids) || !body.block_ids.length || body.block_ids.some(id => typeof id !== 'string' || !id || id.length > 128)) throw invalid('block_ids must list the ids of the blocks to copy');
  if (body.block_ids.length > BLOCK_CLIPBOARD_MAX_BLOCKS) throw invalid(`At most ${BLOCK_CLIPBOARD_MAX_BLOCKS} blocks can be copied at once`);
  return { page_id: body.page_id, block_ids: [...new Set(body.block_ids as string[])] };
}

/** The chosen blocks in page order; a block inside another chosen block comes with it. */
function chosenBlocks(tree: Block[], ids: readonly string[]): Block[] {
  const wanted = new Set(ids);
  const out: Block[] = [];
  const walk = (list: readonly Block[] | undefined) => {
    for (const block of list ?? []) {
      if (wanted.has(block.id)) { out.push(block); continue; }
      walk(block.children);
      for (const slot of block.slots ?? []) walk(slot);
    }
  };
  walk(tree);
  return out;
}

/** Copy blocks of a page's draft to a clipboard. Needs read permission on the site (the route checks it). */
export async function copyBlocks(ctx: CopyCtx, input: { page_id: string; block_ids: string[] }): Promise<CopyResult> {
  const site = { orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId };
  const draft = await loadDraftTree(site, input.page_id);
  if (!draft) throw new PackageError('Page not found', 404, 'page_not_found');
  const missing = input.block_ids.filter(id => !findBlock(draft.tree, id));
  if (missing.length) throw new PackageError(`Block not found: ${missing.join(', ')}`, 404, 'block_not_found');
  const blocks = clone(chosenBlocks(draft.tree, input.block_ids));
  const built = await buildSitePackage(site, { kind: 'clipboard', blocks }, {
    id: 'clipboard', name: `Blocks from ${draft.page.title || draft.page.id}`.slice(0, 120), version: '1',
  }, { mediaMode: 'reference' });
  const clipboard = buildBlockClipboard({
    source: { portal: ctx.portal, site_id: ctx.siteId, site_key: siteKey(ctx.orgId, ctx.siteId), page_id: input.page_id },
    package: built.manifest, media: built.media, page_links: built.page_links,
  });
  const text = serializeBlockClipboard(clipboard);
  if (new TextEncoder().encode(text).byteLength > BLOCK_CLIPBOARD_MAX_BYTES) {
    throw new PackageError(`The copied blocks hold more than ${BLOCK_CLIPBOARD_MAX_BYTES / 1024 / 1024} MB of content; copy fewer at a time`, 413, 'clipboard_too_large');
  }
  return { clipboard, clipboard_text: text, clipboard_html: blockClipboardHtml(clipboard), count: blockClipboardCount(clipboard), warnings: built.warnings };
}

// ── Paste ─────────────────────────────────────────────────────────────────

/** Whether the person pasting may read a site, and which organization owns it; null when not. */
export type SourceAccess = (siteId: string) => Promise<{ orgId: string } | null>;

export interface PasteCtx extends PlaceCtx { portal: string }

export interface PasteRequest extends PagePosition { clipboard: BlockClipboard }

export interface PasteResult {
  report: PackageImportReport;
  page: { id: string; added_ids: string[]; blocks: Block[] };
  /** `same_site`: placed as they are; `other_site`: their styles, block types, global blocks and media were imported. */
  mode: 'same_site' | 'other_site';
  media: { copied: number; reused: number; left_out: number; kept_external: number };
  /** One line for the editor: "Pasted 2 blocks; created the style Hero (imported)". */
  message: string;
}

const PASTE_KEYS = ['clipboard', 'page_id', 'after_block_id', 'position', 'parent_id', 'slot_index'];

/** Check a paste request body. `clipboard` is the clipboard text or its parsed object. */
export function parsePasteRequest(body: unknown): PasteRequest {
  if (!isRecord(body)) throw new PackageError('Send { clipboard, page_id, after_block_id? | position?, parent_id?, slot_index? }', 400, 'clipboard_paste_invalid');
  const unknown = Object.keys(body).filter(key => !PASTE_KEYS.includes(key));
  if (unknown.length) throw new PackageError(`Unknown fields: ${unknown.join(', ')}. Accepted: ${PASTE_KEYS.join(', ')}`, 400, 'clipboard_paste_invalid');
  if (typeof body.page_id !== 'string' || !body.page_id) throw new PackageError('page_id is required', 400, 'clipboard_paste_invalid');
  if (body.clipboard === undefined || body.clipboard === null || body.clipboard === '') throw new PackageError('clipboard is required: the text copy_blocks returned (clipboard_text) or its clipboard object', 400, 'clipboard_invalid');
  let clipboard: BlockClipboard;
  try { clipboard = parseBlockClipboard(body.clipboard); } catch (error) { rethrowClipboard(error); }
  return { clipboard, page_id: body.page_id, ...parsePagePosition(body, 'clipboard_paste_invalid') };
}

const PRIVATE_ADDRESS = /(?:https?:\/\/[^"\s<>()\\]*?)?\/api\/sites\/([a-zA-Z0-9_%.-]+)\/media\/([a-zA-Z0-9_%.-]+)\/content/g;

function decoded(value: string): string | null {
  try { const out = decodeURIComponent(value); return out.includes('/') ? null : out; } catch { return null; }
}

/** Private media addresses in a value: address → { site, media }. */
function privateAddresses(value: unknown): Map<string, { site_id: string; media_id: string; origin: string | null }> {
  const found = new Map<string, { site_id: string; media_id: string; origin: string | null }>();
  for (const match of JSON.stringify(value).matchAll(PRIVATE_ADDRESS)) {
    const site_id = decoded(match[1]), media_id = decoded(match[2]);
    if (!site_id || !media_id) continue;
    const origin = /^https?:\/\//i.test(match[0]) ? (() => { try { return new URL(match[0]).origin; } catch { return null; } })() : null;
    found.set(match[0], { site_id, media_id, origin });
  }
  return found;
}

interface ResolvedMedia {
  pkg: SitePackage;
  files: Map<string, Uint8Array>;
  warnings: string[];
  counts: PasteResult['media'];
}

/**
 * Make an other-site paste's package: links to the source site's pages
 * detached, and each library file the blocks use copied when the person may
 * read its site, else left out (private) or kept (public address).
 */
async function otherSitePackage(ctx: PasteCtx, clipboard: BlockClipboard, sourceAccess: SourceAccess, io: PackageMediaIO): Promise<ResolvedMedia> {
  const warnings: string[] = [];
  const counts = { copied: 0, reused: 0, left_out: 0, kept_external: 0 };
  const pkg = clone(clipboard.package);
  const samePortal = !clipboard.source.portal || clipboard.source.portal === ctx.portal;

  // Links to the source site's pages are kept as their addresses.
  const linkCounts = { links: 0, lists: 0 };
  const links = clipboard.page_links ?? {};
  const detach = (blocks: Block[]) => detachPageLinks(blocks, id => links[id], linkCounts);
  pkg.contents.blocks = detach(pkg.contents.blocks ?? []);
  for (const global of pkg.contents.global_blocks ?? []) global.blocks = detach(global.blocks);
  if (linkCounts.links || linkCounts.lists) {
    warnings.push(`Links to pages of the site the blocks were copied from are kept as plain addresses (${plural(linkCounts.links, 'link')})${linkCounts.lists ? `, and ${plural(linkCounts.lists, 'list')} of chosen pages ${linkCounts.lists === 1 ? 'is' : 'are'} emptied` : ''}; point them at this site's pages.`);
  }

  // Which library file each address belongs to: the clipboard's list, and private addresses found in the content.
  const wanted = new Map<string, { site_id: string; media_id: string; filename?: string; addresses: Set<string> }>();
  const want = (site_id: string, media_id: string, address: string, filename?: string) => {
    const key = `${site_id}/${media_id}`;
    const entry = wanted.get(key) ?? { site_id, media_id, addresses: new Set<string>() };
    entry.addresses.add(address);
    if (filename && !entry.filename) entry.filename = filename;
    wanted.set(key, entry);
  };
  const content = JSON.stringify(pkg.contents);
  for (const ref of clipboard.media ?? []) for (const address of ref.addresses) if (content.includes(address)) want(ref.site_id, ref.media_id, address, ref.filename);
  const privates = privateAddresses(pkg.contents);
  for (const [address, ref] of privates) want(ref.site_id, ref.media_id, address);

  const replacements = new Map<string, string>();
  const access = new Map<string, Promise<{ orgId: string } | null>>();
  const readable = (siteId: string) => {
    if (!access.has(siteId)) access.set(siteId, sourceAccess(siteId).then(result => {
      // The site with this id that the person reaches must be the one copied from.
      if (result && siteId === clipboard.source.site_id && clipboard.source.site_key && siteKey(result.orgId, siteId) !== clipboard.source.site_key) return null;
      return result;
    }).catch(() => null));
    return access.get(siteId)!;
  };
  const library = await getStore().listDocs<Media>(paths.media(ctx.orgId, ctx.siteId));
  const media = new Map<string, PackageMedia>();
  const files = new Map<string, Uint8Array>();
  const leftOut: string[] = [];
  const keptExternal: string[] = [];
  for (const entry of wanted.values()) {
    const addresses = [...entry.addresses];
    const isPrivate = (address: string) => privates.has(address);
    // The target site's own files (a paste back into it from elsewhere) stay as they are.
    if (samePortal && entry.site_id === ctx.siteId && addresses.every(isPrivate)) continue;
    const unreadable = (name: string) => {
      for (const address of addresses) {
        if (isPrivate(address)) replacements.set(address, '');
        else keptExternal.push(address);
      }
      if (addresses.some(isPrivate)) { counts.left_out++; leftOut.push(name); } else counts.kept_external++;
    };
    const owner = samePortal ? await readable(entry.site_id) : null;
    const doc = owner ? await getStore().getDoc<Media>(`${paths.media(owner.orgId, entry.site_id)}/${entry.media_id}`) : null;
    if (!owner || !doc || (doc.storage && doc.storage.state !== 'ready')) { unreadable(doc?.filename ?? entry.filename ?? entry.media_id); continue; }
    const record = { ...doc, id: entry.media_id } as Media;
    // Only addresses that really belong to the file are taken over.
    const known = new Set(mediaAddresses(record));
    const verified = addresses.filter(address => known.has(address) || (isPrivate(address) && privates.get(address)!.site_id === entry.site_id && privates.get(address)!.media_id === entry.media_id));
    if (!verified.length) { unreadable(entry.filename ?? entry.media_id); continue; }
    const existing = record.sha256 ? findMediaBySha(library, record.sha256) : undefined;
    if (existing) {
      for (const address of verified) replacements.set(address, existing.cdn_url);
      counts.reused++;
      continue;
    }
    let bytes: Uint8Array;
    try { bytes = await io.read(owner.orgId, entry.site_id, record); } catch { unreadable(record.filename ?? entry.media_id); continue; }
    const sha = sha256Hex(bytes);
    const id = `m-${sha.slice(0, 20)}`;
    if (!media.has(id)) {
      const ext = mediaFileExtension(record);
      const path = `media/${sha}.${ext}`;
      files.set(path, bytes);
      media.set(id, {
        id, path, sha256: sha, bytes: bytes.byteLength, content_type: record.mime_type || 'application/octet-stream',
        filename: (record.filename || `${id}.${ext}`).slice(0, 200),
        ...(record.alt_text ? { alt_text: record.alt_text } : {}),
        ...(record.title ? { title: record.title } : {}),
        ...(record.width ? { width: record.width } : {}),
        ...(record.height ? { height: record.height } : {}),
      });
      counts.copied++;
    }
    for (const address of verified) replacements.set(address, packageMediaUrl(id));
  }
  if (leftOut.length) {
    warnings.push(`${plural(leftOut.length, 'media file')} (${leftOut.slice(0, 5).join(', ')}${leftOut.length > 5 ? ', …' : ''}) ${leftOut.length === 1 ? 'is' : 'are'} in a site you cannot read${samePortal ? '' : ' on another Typeroll portal'}, so ${leftOut.length === 1 ? 'it was' : 'they were'} left out. Add your own image${leftOut.length === 1 ? '' : 's'} in ${leftOut.length === 1 ? 'its' : 'their'} place.`);
  }
  if (keptExternal.length) warnings.push(`${plural(counts.kept_external, 'file')} could not be copied into this site's Media library and still point${counts.kept_external === 1 ? 's' : ''} at ${counts.kept_external === 1 ? 'its' : 'their'} public address on the other site.`);
  pkg.contents = replaceReferences(pkg.contents, replacements) as SitePackage['contents'];
  pkg.media = [...media.values()];
  pkg.integrity = packageIntegrity(files);
  return { pkg, files, warnings, counts };
}

function pasteMessage(count: number, prepared: PreparedImport | null, counts: PasteResult['media']): string {
  const parts: string[] = [];
  const styles = (prepared?.plan.styles ?? []).filter(entry => entry.action === 'create' || entry.action === 'rename');
  if (styles.length) parts.push(`created ${styles.length === 1 ? 'the style' : 'the styles'} ${styles.map(entry => entry.name).join(', ')}`);
  const types = (prepared?.plan.block_types ?? []).filter(entry => entry.action === 'create' || entry.action === 'rename');
  if (types.length) parts.push(`created ${types.length === 1 ? 'the block type' : 'the block types'} ${types.map(entry => entry.to).join(', ')}`);
  const globals = (prepared?.plan.global_blocks ?? []).filter(entry => entry.action === 'create' || entry.action === 'rename');
  if (globals.length) parts.push(`created ${plural(globals.length, 'global block')}`);
  if (counts.copied) parts.push(`copied ${plural(counts.copied, 'media file')}`);
  if (counts.left_out) parts.push(`left out ${plural(counts.left_out, 'media file')} you cannot read`);
  return `Pasted ${plural(count, 'block')}${parts.length ? `; ${parts.join('; ')}` : ''}`;
}

/**
 * Paste a clipboard's blocks into a page's draft. Needs write permission on
 * the target site; media of another site is copied only when sourceAccess
 * says the person may read that site.
 */
export async function pasteBlocks(ctx: PasteCtx, request: PasteRequest, deps: { sourceAccess: SourceAccess; media?: PackageMediaIO }): Promise<PasteResult> {
  const blocks = request.clipboard.package.contents.blocks ?? [];
  if (ctx.permission === 'read') {
    throw new PackageError('Pasting blocks needs write permission on the site: it changes the page draft and may create the styles, block types, global blocks and media files the blocks use.', 403, 'clipboard_permission');
  }
  const io = deps.media ?? defaultPackageMediaIO;
  const { clipboard } = request;
  const samePortal = !clipboard.source.portal || clipboard.source.portal === ctx.portal;
  const sameSite = samePortal && clipboard.source.site_id === ctx.siteId && (!clipboard.source.site_key || clipboard.source.site_key === siteKey(ctx.orgId, ctx.siteId));
  let read: { manifest: SitePackage; files: Map<string, Uint8Array> };
  let warnings: string[] = [];
  let counts: PasteResult['media'] = { copied: 0, reused: 0, left_out: 0, kept_external: 0 };
  if (sameSite) {
    // The site's own styles, block types, global blocks and media: nothing to import.
    const { global_blocks: _globals, styles: _styles, block_types: _types, ...rest } = clipboard.package.contents;
    void _globals; void _styles; void _types;
    read = { manifest: { ...clone(clipboard.package), contents: clone(rest) }, files: new Map() };
  } else {
    const resolved = await otherSitePackage(ctx, clipboard, deps.sourceAccess, io);
    read = { manifest: resolved.pkg, files: resolved.files };
    warnings = resolved.warnings;
    counts = resolved.counts;
  }
  const errors = sitePackageErrors(read.manifest);
  if (errors.length) throw new PackageError(`The clipboard cannot be pasted: ${errors[0]}`, 422, 'clipboard_invalid', { errors: errors.slice(0, 20) });
  // Block types the blocks use that the site will not have: they show nothing until it does.
  const known = new Set<string>([...buildCoreBlockRegistry().keys(), ...(await vstore.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)).map(type => type.id)]);
  let prepared: PreparedImport | null = null;
  const result = await placePackageBlocks(ctx, read, read.manifest.contents.blocks ?? [], request, {
    code: 'clipboard_paste_invalid', media: io,
    prepare: (plan) => {
      prepared = plan;
      for (const entry of plan.plan.block_types) known.add(entry.to);
      const used = blockTypeRefs(rewriteBlockReferences(read.manifest.contents.blocks ?? [], { blockTypes: plan.plan.maps.blockTypes }));
      const missing = used.filter(type => !known.has(type) && !type.startsWith('app:') && !type.startsWith('extension--'));
      if (missing.length) warnings.push(`The blocks use the block type${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, which this site does not have; ${missing.length === 1 ? 'that block shows' : 'those blocks show'} nothing until ${missing.length === 1 ? 'it is' : 'they are'} added.`);
      plan.warnings.push(...warnings);
    },
  });
  return { ...result, mode: sameSite ? 'same_site' : 'other_site', media: counts, message: pasteMessage(blocks.length, prepared, counts) };
}
