// Saving menus: one path for the v1 API and the portal's cookie routes.
//
// Menus have revisions but no working copy. A save validates the whole
// menu, refuses a location another menu already fills (unless the caller
// asks to take it: `take_locations`), snapshots the menu as it was, and
// replaces it at the active version. It reaches the live site with the next
// publication.

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

/** A location this save moved from another menu, which keeps its items. */
export interface MovedLocation { location: string; from_menu_id: string }

export interface MenuSaveOptions {
  /**
   * Move a location another menu fills to this menu instead of refusing the
   * save. The other menu keeps its items and its other locations; the change
   * is kept as a revision of that menu.
   */
  takeLocations?: boolean;
  updatedBy?: string;
}

/** The menus that fill one of this menu's locations, and which locations. */
async function locationHolders(ctx: MenuCtx, menu: Menu): Promise<Array<{ holder: Menu; locations: string[] }>> {
  if (!menu.locations?.length) return [];
  const others = (await vstore.menus(ctx.orgId, ctx.siteId, ctx.versionId)).filter((other) => other.id !== menu.id);
  const conflicts = locationConflicts([...others, menu]).filter((location) => menu.locations!.includes(location));
  return others.flatMap((holder) => {
    const locations = (holder.locations ?? []).filter((location) => conflicts.includes(location));
    return locations.length ? [{ holder, locations }] : [];
  });
}

/**
 * Refuses a location that another menu of the site already fills, or, with
 * `takeLocations`, removes it from that menu. Runs after validation, so a
 * menu that cannot be saved never takes a location.
 */
async function claimLocations(ctx: MenuCtx, menu: Menu, options: MenuSaveOptions): Promise<{ moved: MovedLocation[]; undo: () => Promise<void> }> {
  const holders = await locationHolders(ctx, menu);
  if (!holders.length) return { moved: [], undo: async () => {} };
  if (!options.takeLocations) {
    const { holder, locations: [location] } = holders[0];
    throw new MenuSaveError(
      `The location "${location}" is already filled by the menu "${holder.name}" (${holder.id}). A location shows one menu: send take_locations: true to move it to this menu (the menu "${holder.name}" keeps its items), or remove it from that menu first.`,
      409,
    );
  }
  const released: Array<{ before: Menu; after: Menu }> = [];
  for (const { holder, locations } of holders) {
    const after: Menu = { ...holder, locations: (holder.locations ?? []).filter((location) => !locations.includes(location)), updated_at: laterStamp(holder.updated_at) };
    await snapshotRevision({
      orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'menu', resourceIds: [holder.id],
      doc: holder as unknown as Record<string, unknown>, createdBy: options.updatedBy ?? 'system',
      note: `Location ${locations.join(', ')} moved to the menu ${menu.id}`,
    });
    await write(ctx, after, holder);
    released.push({ before: holder, after });
  }
  return {
    moved: holders.flatMap(({ holder, locations }) => locations.map((location) => ({ location, from_menu_id: holder.id }))),
    // Best effort: give the locations back when this menu's own save fails.
    undo: async () => { for (const { before, after } of released.reverse()) await write(ctx, { ...before, updated_at: laterStamp(after.updated_at) }, after).catch(() => {}); },
  };
}

async function saveClaiming(ctx: MenuCtx, menu: Menu, expected: Menu | null, options: MenuSaveOptions): Promise<MovedLocation[]> {
  const claim = await claimLocations(ctx, menu, options);
  try { await write(ctx, menu, expected); }
  catch (error) { await claim.undo(); throw error; }
  return claim.moved;
}

/** Reads `take_locations` from a request body: absent, or a boolean. */
export function takeLocationsFlag(input: unknown): boolean {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>).take_locations : undefined;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new MenuSaveError('take_locations must be true or false', 400, [{ path: 'take_locations', message: 'Use true or false' }]);
  return value;
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
export async function createMenu(ctx: MenuCtx, input: unknown, options: MenuSaveOptions = {}): Promise<Menu> {
  return (await createMenuMovingLocations(ctx, input, options)).menu;
}

/** createMenu, also reporting the locations it moved from other menus. */
export async function createMenuMovingLocations(ctx: MenuCtx, input: unknown, options: MenuSaveOptions = {}): Promise<{ menu: Menu; moved_locations: MovedLocation[] }> {
  const { take_locations: _take, ...raw } = body(input);
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
  const moved = await saveClaiming(ctx, menu, null, options);
  return { menu, moved_locations: moved };
}

/**
 * Replaces a whole menu. `expectedUpdatedAt` (the `updated_at` the caller
 * read) makes the save refuse when someone saved the menu in between.
 */
export async function replaceMenu(
  ctx: MenuCtx, menuId: string, input: unknown,
  options: { updatedBy: string; expectedUpdatedAt?: string; note?: string; takeLocations?: boolean },
): Promise<Menu> {
  return (await replaceMenuMovingLocations(ctx, menuId, input, options)).menu;
}

/** replaceMenu, also reporting the locations it moved from other menus. */
export async function replaceMenuMovingLocations(
  ctx: MenuCtx, menuId: string, input: unknown,
  options: { updatedBy: string; expectedUpdatedAt?: string; note?: string; takeLocations?: boolean },
): Promise<{ menu: Menu; moved_locations: MovedLocation[] }> {
  const { take_locations: _take, ...raw } = body(input);
  const existing = await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, menuId);
  if (!existing) throw new MenuSaveError('Menu not found', 404);
  if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== (existing.updated_at ?? ''))
    throw new MenuSaveError('The menu was saved by someone else after you read it. Read it again and reapply your change.', 409);
  const menu = validated({
    ...raw, id: menuId, items: withItemIds(raw.items),
    ...(existing.created_at ? { created_at: existing.created_at } : {}),
    updated_at: laterStamp(existing.updated_at),
  });
  // Refuse a taken location before the revision snapshot, as before.
  if (!options.takeLocations) await claimLocations(ctx, menu, options);
  await snapshotRevision({
    orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'menu', resourceIds: [menuId],
    doc: existing as unknown as Record<string, unknown>, createdBy: options.updatedBy, ...(options.note ? { note: options.note } : {}),
  });
  const moved = await saveClaiming(ctx, menu, existing, options);
  return { menu, moved_locations: moved };
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

/**
 * A new `updated_at`, always later than the saved one. Two saves in the same
 * millisecond would otherwise share a stamp, and a stale replace that sent
 * the first save's stamp would pass the revision check.
 */
export function laterStamp(previous: string | undefined): string {
  const now = Date.now();
  const before = previous ? Date.parse(previous) : NaN;
  return new Date(Number.isFinite(before) && before >= now ? before + 1 : now).toISOString();
}
