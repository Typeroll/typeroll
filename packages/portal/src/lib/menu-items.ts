// Small edits to a menu's item tree, for callers that change one item at a
// time (the AI chat, the WordPress import). The save itself goes through
// menu-write.ts, which validates the whole menu.

import { MAX_MENU_DEPTH, type MenuItem } from '@typeroll/shared';

function ids(items: MenuItem[], out = new Set<string>()): Set<string> {
  for (const item of items) { if (item.id) out.add(item.id); ids(item.children ?? [], out); }
  return out;
}

/** An item id unique in the menu, from the label, page or address. */
export function uniqueItemId(source: string, taken: Set<string>): string {
  const base = source.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'item';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Returns a copy of `items` with `item` appended at the top level or as the
 * last child of `parentId`. The item gets an id when it has none.
 */
export function appendMenuItem(items: MenuItem[], item: unknown, parentId?: string): { items: MenuItem[]; id: string } | { error: string } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'item must be an object such as {"type":"page","page_id":"about"}' };
  const copy = structuredClone(items);
  const entry = { ...(item as Record<string, unknown>) } as unknown as MenuItem;
  const taken = ids(copy);
  if (typeof entry.id === 'string' && entry.id) {
    if (taken.has(entry.id)) return { error: `An item with the id ${entry.id} is already in the menu` };
  } else {
    entry.id = uniqueItemId(String(entry.label || entry.page_id || entry.href || entry.type || 'item'), taken);
  }
  if (!parentId) { copy.push(entry); return { items: copy, id: entry.id }; }
  const find = (list: MenuItem[], depth: number): { parent: MenuItem; depth: number } | null => {
    for (const candidate of list) {
      if (candidate.id === parentId) return { parent: candidate, depth };
      const found = find(candidate.children ?? [], depth + 1);
      if (found) return found;
    }
    return null;
  };
  const found = find(copy, 1);
  if (!found) return { error: `No item ${parentId} in the menu` };
  if (found.depth >= MAX_MENU_DEPTH) return { error: `Menus are at most ${MAX_MENU_DEPTH} levels deep; ${parentId} is already on the last level` };
  if (found.parent.type === 'children') return { error: 'A page-children item lists its pages by itself and cannot hold items' };
  found.parent.children = [...(found.parent.children ?? []), entry];
  return { items: copy, id: entry.id };
}
