// The structure lock of a handed-over site (SiteSettings.handover,
// shared/src/site-handover.ts). With `lock_structure` on, a person without
// design rights (an editor, a client with a shared site) changes the content
// of blocks but cannot add, remove, move, duplicate or retype them, apply a
// page template, or create or delete pages. Builders and administrators are
// never locked.
//
// One helper for every write path: the editor's session routes, the v1 API
// and MCP (which calls the v1 routes). The working-copy layer
// (lib/working-copy.ts) checks block trees itself whenever its context says
// who is writing, so a route that stages a tree is covered even when it does
// not call this module directly.

import { GLOBAL_BLOCK_TYPE_ID, structureLocked, type Block, type SharePermission } from '@typeroll/shared';
import { json } from './access';
import { apiError, type ApiContext } from './api-auth';
import { vstore } from './version-store';

export const STRUCTURE_LOCKED_CODE = 'structure_locked';
export const STRUCTURE_LOCKED_MESSAGE = "The site's structure is locked; you can edit text and images.";

/**
 * Who is writing. A session context sets `canDesign` (SiteContext.design);
 * an API context carries `permission` and `design` (apiCanDesign). A context
 * with neither is a server-side caller (an import, a migration) and is never
 * locked here: those paths have their own design checks.
 */
export interface StructureLockCtx {
  orgId: string;
  siteId: string;
  versionId: string;
  canDesign?: boolean;
  permission?: SharePermission;
  design?: boolean;
}

/** Whether the writer has design rights, or undefined for a server-side caller. */
export function writerCanDesign(ctx: object): boolean | undefined {
  const c = ctx as StructureLockCtx;
  if (typeof c.canDesign === 'boolean') return c.canDesign;
  if (typeof c.permission === 'string') return c.permission === 'admin' || c.design === true;
  return undefined;
}

const lockCache = new WeakMap<object, Promise<boolean>>();

/** True when the site's handover locks the structure for this writer. */
export function structureLockApplies(ctx: StructureLockCtx): Promise<boolean> {
  const canDesign = writerCanDesign(ctx);
  if (canDesign !== false) return Promise.resolve(false);
  let cached = lockCache.get(ctx);
  if (!cached) {
    cached = vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId).then(settings => structureLocked(settings?.handover, false));
    lockCache.set(ctx, cached);
  }
  return cached;
}

/**
 * A tree's structure: block ids, types and nesting (children and slots, in
 * order), and which global block a reference shows. Content (data, styles,
 * names, responsive values) is not part of it.
 */
export function blockStructure(blocks: readonly Block[] | null | undefined): string {
  const shape = (list: readonly Block[] | undefined): unknown[] => (list ?? []).map(block => [
    block.id,
    block.type,
    block.type === GLOBAL_BLOCK_TYPE_ID ? String(block.data?.global_block_id ?? '') : null,
    block.children ? shape(block.children) : null,
    block.slots ? block.slots.map(slot => shape(slot)) : null,
  ]);
  return JSON.stringify(shape(blocks ?? []));
}

export function sameBlockStructure(before: readonly Block[] | null | undefined, after: readonly Block[] | null | undefined): boolean {
  return blockStructure(before) === blockStructure(after);
}

export class StructureLockedError extends Error {
  readonly status = 403;
  readonly code = STRUCTURE_LOCKED_CODE;
  constructor(message = STRUCTURE_LOCKED_MESSAGE) { super(message); this.name = 'StructureLockedError'; }
  toBody() { return { error: this.message, code: this.code }; }
}

/**
 * Refuse a structural change for a locked writer: always when only `before`
 * is omitted (the action is structural by nature, e.g. creating a page),
 * otherwise when the trees differ in structure.
 */
export async function assertStructureChange(ctx: StructureLockCtx, trees?: { before: readonly Block[] | null | undefined; after: readonly Block[] | null | undefined }): Promise<void> {
  if (!(await structureLockApplies(ctx))) return;
  if (trees && sameBlockStructure(trees.before, trees.after)) return;
  throw new StructureLockedError();
}

/** The same check as a ready 403 response `{ error, code: 'structure_locked' }`, or null when allowed. */
export async function structureLockRefusal(ctx: StructureLockCtx, trees?: { before: readonly Block[] | null | undefined; after: readonly Block[] | null | undefined }): Promise<Response | null> {
  try { await assertStructureChange(ctx, trees); return null; } catch (error) {
    if (error instanceof StructureLockedError) return json(error.toBody(), 403);
    throw error;
  }
}

/** structureLockRefusal for the v1 API: the refusal carries the API identity headers. */
export async function apiStructureLockRefusal(ctx: ApiContext, trees?: { before: readonly Block[] | null | undefined; after: readonly Block[] | null | undefined }): Promise<Response | null> {
  try { await assertStructureChange(ctx, trees); return null; } catch (error) {
    if (error instanceof StructureLockedError) return apiError(error.message, 403, ctx, { code: error.code });
    throw error;
  }
}
