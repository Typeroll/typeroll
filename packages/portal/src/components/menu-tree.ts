// Pure tree operations for the portal's menu editor. Every function returns
// a new item list and leaves the input untouched; an operation that would
// break the menu's rules (deeper than MAX_MENU_DEPTH, children under a
// "page's children" item) returns the list unchanged, and the matching
// `can*` function tells the UI to disable the control.

import { MAX_MENU_DEPTH, type MenuItem, type MenuValidationError } from '@typeroll/shared';

export interface ItemLocation {
  item: MenuItem;
  /** Id of the parent item; null at the top level. */
  parentId: string | null;
  index: number;
  /** 1 at the top level. */
  depth: number;
  siblings: MenuItem[];
}

export function findItem(items: MenuItem[], id: string, parentId: string | null = null, depth = 1): ItemLocation | null {
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.id === id) return { item, parentId, index, depth, siblings: items };
    const found = item.children?.length ? findItem(item.children, id, item.id, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

/** Levels an item takes up with its children: 1 for an item without children. */
export function subtreeHeight(item: MenuItem): number {
  return 1 + Math.max(0, ...(item.children ?? []).map(subtreeHeight));
}

export function countItems(items: MenuItem[]): number {
  return items.reduce((total, item) => total + 1 + countItems(item.children ?? []), 0);
}

/** Whether an item may hold children of its own at this depth. */
export function canHoldChildren(item: MenuItem, depth: number): boolean {
  return item.type !== 'children' && depth < MAX_MENU_DEPTH;
}

/** Replaces the sibling list that holds `parentId`'s children (or the top level). */
function withChildren(items: MenuItem[], parentId: string | null, update: (children: MenuItem[]) => MenuItem[]): MenuItem[] {
  if (parentId === null) return update(items);
  return items.map((item) => {
    if (item.id === parentId) {
      const children = update(item.children ?? []);
      const { children: _old, ...rest } = item;
      return children.length ? { ...rest, children } : rest;
    }
    if (!item.children?.length) return item;
    const children = withChildren(item.children, parentId, update);
    return children === item.children ? item : { ...item, children };
  });
}

export function updateItem(items: MenuItem[], id: string, patch: Partial<Omit<MenuItem, 'id' | 'children'>>): MenuItem[] {
  return items.map((item) => {
    if (item.id === id) {
      const next: MenuItem = { ...item, ...patch };
      // An emptied optional field is dropped rather than saved as "".
      for (const key of ['page_id', 'href', 'label', 'description', 'icon', 'link_rel'] as const)
        if (key in patch && (patch[key] === undefined || patch[key] === '')) delete next[key];
      return next;
    }
    if (!item.children?.length) return item;
    return { ...item, children: updateItem(item.children, id, patch) };
  });
}

export function removeItem(items: MenuItem[], id: string): MenuItem[] {
  const at = findItem(items, id);
  if (!at) return items;
  return withChildren(items, at.parentId, (siblings) => siblings.filter((item) => item.id !== id));
}

export function canMove(items: MenuItem[], id: string, delta: -1 | 1): boolean {
  const at = findItem(items, id);
  if (!at) return false;
  const to = at.index + delta;
  return to >= 0 && to < at.siblings.length;
}

/** Moves an item to another position among its siblings. */
export function moveToIndex(items: MenuItem[], id: string, toIndex: number): MenuItem[] {
  const at = findItem(items, id);
  if (!at || toIndex < 0 || toIndex >= at.siblings.length || toIndex === at.index) return items;
  return withChildren(items, at.parentId, (siblings) => {
    const next = siblings.slice();
    const [moved] = next.splice(at.index, 1);
    next.splice(toIndex, 0, moved!);
    return next;
  });
}

export function moveItem(items: MenuItem[], id: string, delta: -1 | 1): MenuItem[] {
  const at = findItem(items, id);
  return at ? moveToIndex(items, id, at.index + delta) : items;
}

/** Indent: the item becomes the last child of the sibling above it. */
export function canIndent(items: MenuItem[], id: string): boolean {
  const at = findItem(items, id);
  if (!at || at.index === 0) return false;
  const above = at.siblings[at.index - 1]!;
  return canHoldChildren(above, at.depth) && at.depth + subtreeHeight(at.item) <= MAX_MENU_DEPTH;
}

export function indentItem(items: MenuItem[], id: string): MenuItem[] {
  if (!canIndent(items, id)) return items;
  const at = findItem(items, id)!;
  const aboveId = at.siblings[at.index - 1]!.id;
  const removed = removeItem(items, id);
  return withChildren(removed, aboveId, (children) => [...children, at.item]);
}

/** Outdent: the item moves out of its parent and lands right after it. */
export function canOutdent(items: MenuItem[], id: string): boolean {
  const at = findItem(items, id);
  return !!at && at.parentId !== null;
}

export function outdentItem(items: MenuItem[], id: string): MenuItem[] {
  const at = findItem(items, id);
  if (!at || at.parentId === null) return items;
  const parent = findItem(items, at.parentId)!;
  const removed = removeItem(items, id);
  return withChildren(removed, parent.parentId, (siblings) => {
    const next = siblings.slice();
    const parentIndex = next.findIndex((item) => item.id === parent.item.id);
    next.splice(parentIndex + 1, 0, at.item);
    return next;
  });
}

/** Whether a new item can go under `parentId` (null: the top level). */
export function canAddTo(items: MenuItem[], parentId: string | null): boolean {
  if (parentId === null) return true;
  const at = findItem(items, parentId);
  return !!at && canHoldChildren(at.item, at.depth);
}

export function addItem(items: MenuItem[], item: MenuItem, parentId: string | null = null): MenuItem[] {
  if (!canAddTo(items, parentId)) return items;
  return withChildren(items, parentId, (siblings) => [...siblings, item]);
}

/** An item id not yet used in the menu (`item-1`, `item-2`, …). */
export function nextItemId(items: MenuItem[]): string {
  const taken = new Set<string>();
  const walk = (list: MenuItem[]) => list.forEach((item) => { taken.add(item.id); walk(item.children ?? []); });
  walk(items);
  let n = 1;
  while (taken.has(`item-${n}`)) n++;
  return `item-${n}`;
}

/** Every item in display order with its depth, for flat lists and parent pickers. */
export function flattenItems(items: MenuItem[], depth = 1): Array<{ item: MenuItem; depth: number }> {
  return items.flatMap((item) => [{ item, depth }, ...flattenItems(item.children ?? [], depth + 1)]);
}

/**
 * The item and field a server validation path points at, e.g.
 * `items[0].children[1].label` → { id, field: 'label' }. Null for menu-level
 * paths (`name`, `locations[0]`) or a path that no longer matches the tree.
 */
export function itemForPath(items: MenuItem[], path: string): { id: string; field: string | null } | null {
  const match = /^items\[(\d+)\]((?:\.children\[\d+\])*)(?:\.([a-z_]+))?$/.exec(path);
  if (!match) return null;
  let item: MenuItem | undefined = items[Number(match[1])];
  for (const step of match[2]!.matchAll(/\[(\d+)\]/g)) item = item?.children?.[Number(step[1])];
  return item ? { id: item.id, field: match[3] ?? null } : null;
}

/** Server errors grouped by item id; menu-level ones under the empty key. */
export function errorsByItem(items: MenuItem[], errors: MenuValidationError[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const error of errors) {
    const target = itemForPath(items, error.path);
    const key = target?.id ?? '';
    const field = target?.field && target.field !== 'children' ? `${fieldLabel(target.field)}: ` : '';
    const message = target ? `${field}${error.message}` : error.path ? `${error.path}: ${error.message}` : error.message;
    out.set(key, [...(out.get(key) ?? []), message]);
  }
  return out;
}

function fieldLabel(field: string): string {
  return ({ page_id: 'Page', href: 'Address', label: 'Label', description: 'Description', icon: 'Icon', link_rel: 'Link rel', id: 'Id', type: 'Type' } as Record<string, string>)[field] ?? field;
}

/** Why an address can't be a custom link, or null when it can. Mirrors validateMenu. */
export function hrefProblem(href: string): string | null {
  const value = href.trim();
  if (!value) return 'Give the address';
  if (/^\s*(javascript|data|vbscript):/i.test(value)) return 'This kind of address is not allowed';
  return null;
}

/** A custom location typed by a person, as the menu stores it (`Side bar` → `side-bar`). */
export function normalizeLocation(input: string): string {
  return input.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40);
}
