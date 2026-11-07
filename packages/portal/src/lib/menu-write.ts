// Saving menus: one path for the v1 API and the portal's cookie routes.
//
// Menus have revisions but no working copy. A save validates the whole
// menu, refuses a location another menu already fills, snapshots the menu
// as it was, and replaces it at the active version. It reaches the live
// site with the next publication.

import { locationConflicts, validateMenu, type Menu, type MenuValidationError } from '@typeroll/shared';
import { snapshotRevision } from './revisions';
import { MenuWriteConflict, vstore } from './version-store';

export interface MenuCtx { orgId: string; siteId: string; versionId: string }

export class MenuSaveError extends Error {
  constructor(message: string, readonly status: number, readonly errors?: MenuValidationError[]) { super(message); }
}

const MENU_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function menuIdFromName(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'menu';
}

/** Gives every item without an id one that is unique in the menu. */
function withItemIds(items: unknown): unknown {
  if (!Array.isArray(items)) return items;
  const taken = new Set<string>();
  const collect = (list: unknown[]) => list.forEach((entry) => {
    if (entry && typeof entry === 'object') {
      const raw = entry as Record<string, unknown>;
      if (typeof raw.id === 'string' && raw.id) taken.add(raw.id);
      if (Array.isArray(raw.children)) collect(raw.children);
    }
  });
  collect(items);
  let n = 1;
  const next = () => { while (taken.has(`item-${n}`)) n++; taken.add(`item-${n}`); return `item-${n}`; };
  const assign = (list: unknown[]): unknown[] => list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const raw = entry as Record<string, unknown>;
    return {
      ...raw,
      ...(raw.id === undefined || raw.id === null || raw.id === '' ? { id: next() } : {}),
      ...(Array.isArray(raw.children) ? { children: assign(raw.children) } : {}),
    };
  });
  return assign(items);
}

function validated(input: Record<string, unknown>): Menu {
  const { menu, errors } = validateMenu(input);
  if (!menu) throw new MenuSaveError(`The menu is not valid: ${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`, 400, errors);
  return menu;
}

/** Refuses a location that another menu of the site already fills. */
async function assertLocationsFree(ctx: MenuCtx, menu: Menu): Promise<void> {
  if (!menu.locations?.length) return;
  const others = (await vstore.menus(ctx.orgId, ctx.siteId, ctx.versionId)).filter((other) => other.id !== menu.id);
  const conflicts = locationConflicts([...others, menu]).filter((location) => menu.locations!.includes(location));
  if (!conflicts.length) return;
  const location = conflicts[0];
  const owner = others.find((other) => other.locations?.includes(location));
  throw new MenuSaveError(
    `The location "${location}" is already filled by the menu "${owner?.name ?? owner?.id}" (${owner?.id}). Remove it from that menu first; a location shows one menu.`,
    409,
  );
}

async function write(ctx: MenuCtx, menu: Menu, expected: Menu | null): Promise<void> {
  try { await vstore.writeMenu(ctx.orgId, ctx.siteId, ctx.versionId, menu, expected); }
  catch (error) {
    if (error instanceof MenuWriteConflict) throw new MenuSaveError(error.message, 409);
    throw error;
  }
}

function body(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MenuSaveError('Send the menu as a JSON object', 400);
  return input as Record<string, unknown>;
}

/**
 * Creates a menu. A valid `id` from the caller is kept (409 when taken);
 * without one the id is derived from the name and made unique.
 */
export async function createMenu(ctx: MenuCtx, input: unknown): Promise<Menu> {
  const raw = body(input);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  let id: string;
  if (raw.id !== undefined && raw.id !== null && raw.id !== '') {
    id = String(raw.id);
    if (!MENU_ID.test(id)) throw new MenuSaveError('id: Use lowercase letters, digits, hyphens and underscores (at most 64)', 400, [{ path: 'id', message: 'Use lowercase letters, digits, hyphens and underscores (at most 64)' }]);
    if (await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, id)) throw new MenuSaveError(`A menu with the id ${id} already exists; update it with PUT`, 409);
  } else {
    const taken = new Set((await vstore.menus(ctx.orgId, ctx.siteId, ctx.versionId)).map((menu) => menu.id));
    const base = menuIdFromName(name);
    id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  }
  const now = new Date().toISOString();
  const menu = validated({ ...raw, id, items: withItemIds(raw.items ?? []), created_at: now, updated_at: now });
  await assertLocationsFree(ctx, menu);
  await write(ctx, menu, null);
  return menu;
}

/**
 * Replaces a whole menu. `expectedUpdatedAt` (the `updated_at` the caller
 * read) makes the save refuse when someone saved the menu in between.
 */
export async function replaceMenu(
  ctx: MenuCtx, menuId: string, input: unknown,
  options: { updatedBy: string; expectedUpdatedAt?: string; note?: string },
): Promise<Menu> {
  const raw = body(input);
  const existing = await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, menuId);
  if (!existing) throw new MenuSaveError('Menu not found', 404);
  if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== (existing.updated_at ?? ''))
    throw new MenuSaveError('The menu was saved by someone else after you read it. Read it again and reapply your change.', 409);
  const menu = validated({
    ...raw, id: menuId, items: withItemIds(raw.items),
    ...(existing.created_at ? { created_at: existing.created_at } : {}),
    updated_at: new Date().toISOString(),
  });
  await assertLocationsFree(ctx, menu);
  await snapshotRevision({
    orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'menu', resourceIds: [menuId],
    doc: existing as unknown as Record<string, unknown>, createdBy: options.updatedBy, ...(options.note ? { note: options.note } : {}),
  });
  await write(ctx, menu, existing);
  return menu;
}

/** Restores a revision's name, locations, settings and items. */
export async function restoreMenuRevision(ctx: MenuCtx, menuId: string, doc: Partial<Menu>, revId: string, updatedBy: string): Promise<Menu> {
  return replaceMenu(ctx, menuId, {
    name: doc.name, items: doc.items ?? [],
    ...(doc.locations ? { locations: doc.locations } : {}),
    ...(doc.auto_add_pages ? { auto_add_pages: true } : {}),
  }, { updatedBy, note: `Replaced by restore of ${revId}` });
}

export async function removeMenu(ctx: MenuCtx, menuId: string): Promise<void> {
  if (!(await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, menuId))) throw new MenuSaveError('Menu not found', 404);
  await vstore.deleteMenu(ctx.orgId, ctx.siteId, ctx.versionId, menuId);
}
