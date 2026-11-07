// Place a package's blocks in a page draft: the path shared by inserting a
// collection entry into a page and pasting copied blocks.
//
// The package is imported with design "content" first (package-import.ts):
// the styles, block types, free global blocks and media the blocks use are
// created on the site, styles never mapped to "nearest" ones and differing
// ones created under new ids. The blocks are then rewritten the way the
// import rewrote its content, given new ids and inserted into the page's
// working copy after a (possibly nested) block, or at a position.

import { copyBlocksWithNewIds, type Block, type SharePermission } from '@typeroll/shared';
import { loadDraftTree, saveDraftTree } from '../page-draft-tree';
import { findBlock } from '../block-mutations';
import { insertBlocks } from '../reusable-block-ops';
import { importSitePackageIntoVersion, preparePackageImport, type PackageImportReport, type PreparedImport } from './package-import';
import type { PackageMediaIO } from './package-media';
import { PackageError, type PackageErrorCode, type PackageFiles } from './package-zip';

export interface PagePosition {
  page_id: string;
  after_block_id?: string;
  position?: number;
  parent_id?: string | null;
  slot_index?: number;
}

export interface PlaceCtx {
  orgId: string; siteId: string; versionId: string;
  permission: SharePermission;
  design?: boolean;
  actor: string;
}

export interface PlaceResult {
  report: PackageImportReport;
  page: { id: string; added_ids: string[]; blocks: Block[] };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Check a page position from a request body (the keys after_block_id, position, parent_id, slot_index). */
export function parsePagePosition(input: Record<string, unknown>, code: PackageErrorCode): Omit<PagePosition, 'page_id'> {
  if (input.after_block_id !== undefined && (typeof input.after_block_id !== 'string' || !input.after_block_id)) throw new PackageError('after_block_id must be a block id', 400, code);
  if (input.after_block_id !== undefined && (input.position !== undefined || input.parent_id !== undefined || input.slot_index !== undefined)) throw new PackageError('Send after_block_id or a position, not both', 400, code);
  for (const key of ['position', 'slot_index'] as const) if (input[key] !== undefined && (!Number.isInteger(input[key]) || (input[key] as number) < 0)) throw new PackageError(`${key} must be a non-negative integer`, 400, code);
  if (input.parent_id !== undefined && input.parent_id !== null && typeof input.parent_id !== 'string') throw new PackageError('parent_id must be a block id or null', 400, code);
  return {
    ...(typeof input.after_block_id === 'string' ? { after_block_id: input.after_block_id } : {}),
    ...(input.position !== undefined ? { position: input.position as number } : {}),
    ...(input.parent_id !== undefined ? { parent_id: input.parent_id as string | null } : {}),
    ...(input.slot_index !== undefined ? { slot_index: input.slot_index as number } : {}),
  };
}

type Site = { orgId: string; siteId: string; versionId: string };
type Draft = NonNullable<Awaited<ReturnType<typeof loadDraftTree>>>;

/** The page draft and where in it the blocks go; checked before anything is written. */
export async function resolvePagePosition(site: Site, target: PagePosition, code: PackageErrorCode): Promise<{ draft: Draft; at: { parent_id?: string | null; slot_index?: number; position?: number } }> {
  const draft = await loadDraftTree(site, target.page_id);
  if (!draft) throw new PackageError('Page not found', 404, 'page_not_found');
  if (draft.page.content_mode === 'html') throw new PackageError('This page uses HTML mode; blocks cannot be placed in it', 400, code);
  if (target.after_block_id) {
    const found = findBlock(draft.tree, target.after_block_id);
    if (!found) throw new PackageError(`Block not found: ${target.after_block_id}`, 404, 'block_not_found');
    return { draft, at: { parent_id: found.parent?.id ?? null, ...(found.parentSlotIndex !== null ? { slot_index: found.parentSlotIndex } : {}), position: found.index + 1 } };
  }
  const at = { ...(target.parent_id !== undefined ? { parent_id: target.parent_id } : {}), ...(target.slot_index !== undefined ? { slot_index: target.slot_index } : {}), ...(target.position !== undefined ? { position: target.position } : {}) };
  if (at.parent_id && !findBlock(draft.tree, at.parent_id)) throw new PackageError(`Parent block not found: ${at.parent_id}`, 404, 'block_not_found');
  return { draft, at };
}

/**
 * Import a package (design "content") and place `place`, blocks of that
 * package, in the page's draft. `prepare` may adjust the prepared import
 * (for example drop warnings that do not apply) before it runs.
 */
export async function placePackageBlocks(ctx: PlaceCtx, read: PackageFiles, place: Block[], target: PagePosition, options: {
  code: PackageErrorCode;
  media?: PackageMediaIO;
  prepare?: (prepared: PreparedImport) => void;
}): Promise<PlaceResult> {
  const site = { orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId };
  const { draft, at } = await resolvePagePosition(site, target, options.code);
  const prepared = await preparePackageImport(site, read, { design: 'content' });
  prepared.warnings = prepared.warnings.filter(warning => !warning.startsWith('Copied blocks are pasted'));
  options.prepare?.(prepared);
  let convert: ((blocks: Block[]) => Block[]) | null = null;
  const report = await importSitePackageIntoVersion({ ...site, permission: ctx.permission, design: ctx.design, actor: ctx.actor }, prepared, {
    media: options.media, onImported: (fn) => { convert = fn; },
  });
  // Re-read the draft: the import took a moment, and an editor may have saved since.
  const current = (await loadDraftTree(site, draft.page.id)) ?? draft;
  const rewrite = (convert as ((blocks: Block[]) => Block[]) | null) ?? ((tree: Block[]) => tree);
  const blocks = copyBlocksWithNewIds(rewrite(clone(place)));
  const inserted = insertBlocks(current.tree, blocks, at);
  await saveDraftTree(site, current.page.id, inserted.blocks);
  return { report, page: { id: current.page.id, added_ids: inserted.added_ids, blocks: inserted.blocks } };
}
