// Menus: named trees of links a site keeps once and shows in its header,
// footer and mobile menu. Saved directly (revision checked, no working copy);
// they reach the live site with the next publication.

import { z } from 'zod';
import { ApiError } from '../client.js';
import { fail, ok, versionParam, type ToolDef, type ToolResult } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

const MENU_MODEL =
  'A menu has an id, a name, optional `locations` and a tree of `items` at most 3 levels deep (top level, submenu, and a third level that makes a wide submenu in columns). ' +
  'Item types: `page` (page_id; links by page id, so the label and address follow renames and moves, and an unpublished or deleted page drops out with a warning; `label` overrides the title), ' +
  '`url` (href and label; an external address, a path or an #anchor), `children` (page_id; lists that page\'s published child pages automatically: with a label they form a submenu under it, without one they sit in place) ' +
  'and `heading` (label only, no link; a column title in a wide submenu). Any item may set `description` (a short line in submenus), `icon` and `link_rel`. Items with `children` get a submenu. ' +
  'Locations: `primary` (header), `footer` and `mobile`, or another short lowercase name; one menu per location per site. ' +
  '`auto_add_pages: true` appends new top-level published pages (other than the home page) to the end automatically. ' +
  'To show a menu, use a `core/navigation_links` block with data { source: "menu", menu: "location:primary" } (or a menu id) and optionally `submenus`: auto (dropdown in a row, accordion in a column and the mobile drawer), dropdown, accordion, expanded or none. It needs render version 15 (read_site_settings → render.version; raise it with tr-upgrade-rendering).';

// Nested items have the same shape; they stay untyped here so the schema is
// not recursive (the server validates the whole tree and reports each path).
const itemShape = z.object({
  id: z.string().optional().describe('Unique in the menu (lowercase letters, digits, - and _). Omit for a new item to get one.'),
  type: z.enum(['page', 'url', 'children', 'heading']),
  page_id: z.string().optional().describe('page and children items: the page id (not its slug or URL).'),
  href: z.string().optional().describe('url items: the address, path or #anchor.'),
  label: z.string().optional().describe('Required for url and heading; overrides the page title for page items.'),
  description: z.string().optional(),
  icon: z.string().optional(),
  link_rel: z.string().optional().describe('For example "nofollow sponsored".'),
  children: z.array(z.record(z.string(), z.unknown())).optional().describe('Submenu items of the same shape. At most 3 levels in all.'),
}).passthrough();

/** A 400 from a menu save carries every problem with its path; show them plainly. */
function menuFailure(error: unknown): ToolResult {
  if (error instanceof ApiError && error.status === 400) {
    const errors = (error.body as { details?: { errors?: Array<{ path: string; message: string }> } } | null)?.details?.errors;
    if (Array.isArray(errors) && errors.length) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'The menu was not saved: it is not valid.',
            status: 400,
            errors,
            hint: 'Fix each path (for example items[1].children[0].href) and send the whole menu again.',
          }, null, 2),
        }],
        isError: true,
      };
    }
  }
  if (error instanceof ApiError && error.status === 409) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error.message,
          status: 409,
          hint: 'Either someone saved the menu after you read it (read_menu again and reapply your change with the new updated_at), or a location you set is already filled by another menu (remove it there first).',
        }, null, 2),
      }],
      isError: true,
    };
  }
  return fail(error);
}

interface MenuItemLike { id?: string; children?: MenuItemLike[]; [key: string]: unknown }
interface MenuLike { id: string; name: string; locations?: string[]; auto_add_pages?: boolean; items: MenuItemLike[]; updated_at?: string }

function itemIds(items: MenuItemLike[], out = new Set<string>()): Set<string> {
  for (const item of items) {
    if (typeof item.id === 'string' && item.id) out.add(item.id);
    if (Array.isArray(item.children)) itemIds(item.children, out);
  }
  return out;
}

/** Path of nesting levels to the item with `id`: the item list it sits in and its depth. */
function findItem(items: MenuItemLike[], id: string, depth = 1): { item: MenuItemLike; depth: number } | null {
  for (const item of items) {
    if (item.id === id) return { item, depth };
    const found = Array.isArray(item.children) ? findItem(item.children, id, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

function newItemId(item: Record<string, unknown>, taken: Set<string>): string {
  const source = String(item.label ?? item.page_id ?? item.href ?? item.type ?? 'item');
  const base = source.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'item';
  let id = /^[a-z0-9]/.test(base) ? base : `item-${base}`;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const menuBody = (menu: { name?: string; locations?: string[]; auto_add_pages?: boolean; items: unknown[] }) => ({
  name: menu.name,
  ...(menu.locations !== undefined ? { locations: menu.locations } : {}),
  ...(menu.auto_add_pages !== undefined ? { auto_add_pages: menu.auto_add_pages } : {}),
  items: menu.items,
});

export const menuTools: ToolDef[] = [
  {
    name: 'list_menus',
    description:
      'List the site\'s menus (WordPress-style menus with locations): each with its id, name, locations, auto_add_pages, items and updated_at. ' +
      'Check this before building a header or footer: a new site starts with a `primary` menu (location primary, Home, auto_add_pages on) and a `footer` menu. ' + MENU_MODEL,
    inputSchema: { version: versionParam },
    handler: async (args, { client, siteId }) => {
      try { return ok(await client.get(siteId, 'menus', v(args.version))); } catch (error) { return fail(error); }
    },
  },
  {
    name: 'read_menu',
    description:
      'Read one menu with its whole item tree and updated_at. Pass that updated_at as expected_updated_at to update_menu so a save made in between is not overwritten.',
    inputSchema: { menu_id: z.string(), version: versionParam },
    handler: async (args, { client, siteId }) => {
      try { return ok(await client.get(siteId, `menus/${encodeURIComponent(args.menu_id)}`, v(args.version))); } catch (error) { return fail(error); }
    },
  },
  {
    name: 'update_menu',
    description:
      'Create a menu or replace a whole menu (name, locations, auto_add_pages and the full item tree). ' +
      'To change an existing menu: read_menu, edit the tree, and send it back with expected_updated_at set to the updated_at you read; a save by someone else in between returns 409. Without menu_id, or with a menu_id that does not exist yet, the menu is created. ' +
      'Every save is validated as a whole and keeps the previous menu as a revision; an invalid menu returns `errors` with the path of each problem (for example items[0].href). ' +
      'Link pages with type "page" and their page_id (from list_pages), not with url items, so renames follow; use a "children" item for an automatic submenu of a page\'s child pages. ' +
      'Menus are saved directly (no working copy) and reach the live site with the next publication. To add one item, add_menu_item is simpler. ' + MENU_MODEL,
    inputSchema: {
      menu_id: z.string().optional().describe('The menu to replace or create. Omit to create a menu whose id is derived from the name.'),
      name: z.string().describe('Shown in the portal, e.g. "Main menu".'),
      locations: z.array(z.string()).optional().describe('primary, footer, mobile or another short lowercase name. Omit to keep none; [] clears them.'),
      auto_add_pages: z.boolean().optional().describe('Append new top-level published pages automatically.'),
      items: z.array(itemShape).describe('The whole item tree, at most 3 levels deep and 200 items.'),
      expected_updated_at: z.string().optional().describe('The updated_at from read_menu or list_menus. Required to replace an existing menu.'),
      version: versionParam,
    },
    handler: async (args, { client, siteId }) => {
      const body = menuBody(args as { name: string; locations?: string[]; auto_add_pages?: boolean; items: unknown[] });
      try {
        if (args.menu_id && args.expected_updated_at !== undefined) {
          return ok(await client.put(siteId, `menus/${encodeURIComponent(args.menu_id)}`, { ...body, expected_updated_at: args.expected_updated_at }, v(args.version)));
        }
        if (args.menu_id) {
          let exists = true;
          try { await client.get(siteId, `menus/${encodeURIComponent(args.menu_id)}`, v(args.version)); }
          catch (error) { if (error instanceof ApiError && error.status === 404) exists = false; else throw error; }
          if (exists) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: `The menu ${args.menu_id} already exists. Read it with read_menu and pass its updated_at as expected_updated_at to replace it.`, status: 409 }, null, 2) }],
              isError: true,
            };
          }
        }
        return ok(await client.post(siteId, 'menus', { ...(args.menu_id ? { id: args.menu_id } : {}), ...body }, v(args.version)));
      } catch (error) { return menuFailure(error); }
    },
  },
  {
    name: 'add_menu_item',
    description:
      'Append one item to a menu, at the top level or under a parent item (parent_item_id), and save it. Reads the menu and saves it with its updated_at, so a concurrent save is refused with 409 rather than lost. ' +
      'Example: { menu_id: "primary", item: { type: "page", page_id: "about" } } or a submenu entry { menu_id: "primary", parent_item_id: "services", item: { type: "url", href: "https://shop.example.com", label: "Shop" } }. ' +
      'Use type "page" with a page_id (it follows renames), "children" for the page\'s child pages as an automatic submenu, "url" for other addresses and "heading" for a column title. Menus are at most 3 levels deep. ' +
      'Returns the saved menu and the new item\'s id. To restructure or remove items, use read_menu and update_menu.',
    inputSchema: {
      menu_id: z.string(),
      item: itemShape,
      parent_item_id: z.string().optional().describe('Put the item in this item\'s submenu (as its last child). Omit for the top level.'),
      position: z.number().int().min(0).optional().describe('Index to insert at among its siblings. Default: at the end.'),
      version: versionParam,
    },
    handler: async (args, { client, siteId }) => {
      try {
        const path = `menus/${encodeURIComponent(args.menu_id)}`;
        const read = await client.get<{ menu?: MenuLike }>(siteId, path, v(args.version));
        const menu = read?.menu;
        if (!menu || !Array.isArray(menu.items)) throw new Error(`The menu ${args.menu_id} could not be read`);
        const items = structuredClone(menu.items);
        const item = { ...(args.item as Record<string, unknown>) };
        const taken = itemIds(items);
        if (typeof item.id === 'string' && item.id) {
          if (taken.has(item.id)) return { content: [{ type: 'text', text: JSON.stringify({ error: `An item with the id ${item.id} is already in the menu. Choose another id or omit it.`, status: 400 }, null, 2) }], isError: true };
        } else item.id = newItemId(item, taken);
        let siblings = items;
        if (args.parent_item_id) {
          const parent = findItem(items, args.parent_item_id);
          if (!parent) return { content: [{ type: 'text', text: JSON.stringify({ error: `No item ${args.parent_item_id} in the menu ${args.menu_id}. read_menu lists the item ids.`, status: 404 }, null, 2) }], isError: true };
          if (parent.depth >= 3) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Menus are at most 3 levels deep; the parent is already on the third level.', status: 400 }, null, 2) }], isError: true };
          if (parent.item.type === 'children') return { content: [{ type: 'text', text: JSON.stringify({ error: 'A "children" item lists its pages by itself and cannot hold items. Choose another parent.', status: 400 }, null, 2) }], isError: true };
          parent.item.children = Array.isArray(parent.item.children) ? parent.item.children : [];
          siblings = parent.item.children;
        }
        const at = args.position === undefined ? siblings.length : Math.min(args.position, siblings.length);
        siblings.splice(at, 0, item);
        const saved = await client.put(siteId, path, { ...menuBody({ ...menu, items }), expected_updated_at: menu.updated_at ?? '' }, v(args.version));
        return ok({ item_id: item.id, ...(saved as Record<string, unknown>) });
      } catch (error) { return menuFailure(error); }
    },
  },
  {
    name: 'delete_menu',
    description:
      'Delete a menu. A navigation block that shows it (by id or by its location) then renders an empty list until another menu fills the location. Check where it is shown first with find_menu_usage. Takes effect at the next publication.',
    inputSchema: { menu_id: z.string(), version: versionParam },
    handler: async (args, { client, siteId }) => {
      try { return ok(await client.del(siteId, `menus/${encodeURIComponent(args.menu_id)}`, v(args.version))); } catch (error) { return fail(error); }
    },
  },
  {
    name: 'find_menu_usage',
    description:
      'Where a menu is shown: the global blocks (header, footer, others), pages and page templates whose core/navigation_links block has source "menu" and names this menu by id or by one of its locations (location:primary), saved or in a draft. Read it before deleting a menu or moving its location.',
    inputSchema: { menu_id: z.string(), version: versionParam },
    handler: async (args, { client, siteId }) => {
      try { return ok(await client.get(siteId, `menus/${encodeURIComponent(args.menu_id)}/usage`, v(args.version))); } catch (error) { return fail(error); }
    },
  },
];
