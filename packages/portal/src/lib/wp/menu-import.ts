// WordPress menus → Typeroll menus.
//
// Each WordPress menu becomes one menu. Items that point at an imported page
// or category become page items (by page id, so later renames follow);
// anything else becomes an address. WordPress nests menus without limit;
// Typeroll keeps three levels, so deeper items move up into the third level,
// in order after their ancestor. Theme locations map onto Typeroll's
// `primary`, `footer` and `mobile` by name; other names are kept when valid.

import { MAX_MENU_DEPTH, MAX_MENU_ITEMS, type Menu, type MenuItem } from '@typeroll/shared';
import { normalizeWordPressPlainText } from './plain-text';

export interface WordPressMenuItemSource {
  id: number;
  title: string;
  url: string;
  parent: number;
  order: number;
  /** Post type or taxonomy linked to (page, post, category …). */
  object?: string;
  object_id?: number;
  /** post_type, taxonomy, custom or post_type_archive. */
  type?: string;
  description?: string;
}

export interface WordPressMenuSource {
  id: number;
  name: string;
  slug: string;
  /** Theme locations, e.g. primary, footer, mobile-menu. */
  locations: string[];
  items: WordPressMenuItemSource[];
}

/** What the importer knows about a page of the target site. */
export interface MenuImportPage {
  id: string;
  title?: string;
  path?: string;
  old_wp_url?: string;
}

const LOCATION = /^[a-z][a-z0-9_-]{0,39}$/;
const MENU_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The Typeroll location for a WordPress theme location, or null to leave it out. */
export function mapWordPressLocation(name: string): string | null {
  const value = name.trim().toLowerCase();
  if (!value) return null;
  if (/mobile|handheld|off-?canvas|responsive/.test(value)) return 'mobile';
  if (/footer|bottom/.test(value)) return 'footer';
  if (/primary|main|header|^menu[-_]?1$|^top$|^nav(igation)?$/.test(value)) return 'primary';
  const kept = value.replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40);
  return LOCATION.test(kept) ? kept : null;
}

/** Path plus query, without a trailing slash, for comparing addresses. */
function comparable(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== new URL(origin).origin) return null;
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${path}${parsed.search}`;
  } catch { return null; }
}

function slugId(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 60).replace(/[-_]+$/, '');
}

/** The Typeroll id for an imported menu: `wp-<slug>`. */
export function importedMenuId(menu: Pick<WordPressMenuSource, 'id' | 'slug' | 'name'>): string {
  const base = slugId(menu.slug || menu.name) || String(menu.id);
  const id = `wp-${base}`.slice(0, 64).replace(/[-_]+$/, '');
  return MENU_ID.test(id) ? id : `wp-menu-${menu.id}`;
}

export interface ConvertedMenu {
  source_id: number;
  menu: Omit<Menu, 'created_at' | 'updated_at'>;
  /** Theme locations that map to no valid Typeroll location. */
  dropped_locations: string[];
}

/**
 * Converts one WordPress menu. `pages` are the target site's pages: an item
 * links a page when its object is an imported page or term (`wp-<type>-<id>`,
 * `wp-term-<taxonomy>-<id>`) or its address is a page's old WordPress address
 * or current path. The source's home address links the home page.
 */
export function convertWordPressMenu(source: WordPressMenuSource, pages: MenuImportPage[], sourceOrigin: string): ConvertedMenu {
  const ids = new Set(pages.map((page) => page.id));
  const byAddress = new Map<string, MenuImportPage>();
  for (const page of pages) {
    for (const address of [page.old_wp_url, page.path]) {
      const key = address ? comparable(address, sourceOrigin) : null;
      if (key && !byAddress.has(key)) byAddress.set(key, page);
    }
  }
  const home = pages.find((page) => page.id === 'home');
  const pageFor = (item: WordPressMenuItemSource): MenuImportPage | undefined => {
    if (item.object && item.object_id) {
      const candidate = item.type === 'taxonomy' ? `wp-term-${item.object}-${item.object_id}` : `wp-${item.object}-${item.object_id}`;
      if (ids.has(candidate)) return pages.find((page) => page.id === candidate);
    }
    // An anchor (#contact, /#contact) points into a page, not at it.
    if (!item.url || item.url.includes('#')) return undefined;
    const key = comparable(item.url, sourceOrigin);
    if (!key) return undefined;
    if (key === '/' && home) return home;
    return byAddress.get(key);
  };

  const children = new Map<number, WordPressMenuItemSource[]>();
  const known = new Set(source.items.map((item) => item.id));
  for (const item of source.items) {
    // An item whose parent is missing from the menu sits at the top level.
    const parent = item.parent && known.has(item.parent) && item.parent !== item.id ? item.parent : 0;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.id - b.id);

  let count = 0;
  const convert = (item: WordPressMenuItemSource): MenuItem | null => {
    if (++count > MAX_MENU_ITEMS) return null;
    const label = normalizeWordPressPlainText(item.title ?? '').slice(0, 120).trim();
    const description = normalizeWordPressPlainText(item.description ?? '').slice(0, 200).trim();
    const id = `wp-${item.id}`;
    const page = pageFor(item);
    const href = (item.url ?? '').trim();
    let out: MenuItem;
    if (page) {
      out = { id, type: 'page', page_id: page.id, ...(label && label !== page.title ? { label } : {}) };
    } else if (!href || href === '#' || /^\s*(javascript|data|vbscript):/i.test(href)) {
      // WordPress uses "#" custom links as parents that only open a submenu.
      out = { id, type: 'heading', label: label || 'Menu' };
    } else {
      const local = comparable(href, sourceOrigin);
      let address = href;
      if (local) {
        // Same-site addresses keep their path, so they follow the site to its new domain.
        const parsed = new URL(href, sourceOrigin);
        address = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      out = { id, type: 'url', href: address, label: label || address };
    }
    if (description) out.description = description;
    return out;
  };
  const build = (item: WordPressMenuItemSource, depth: number): MenuItem[] => {
    const converted = convert(item);
    if (!converted) return [];
    const kids = children.get(item.id) ?? [];
    if (depth < MAX_MENU_DEPTH) {
      const nested = kids.flatMap((child) => build(child, depth + 1));
      if (nested.length) converted.children = nested;
      return [converted];
    }
    // On the last level, descendants follow the item as its siblings.
    const flattened: MenuItem[] = [];
    const walk = (list: WordPressMenuItemSource[]) => list.forEach((child) => {
      const value = convert(child);
      if (value) flattened.push(value);
      walk(children.get(child.id) ?? []);
    });
    walk(kids);
    return [converted, ...flattened];
  };
  const items = (children.get(0) ?? []).flatMap((item) => build(item, 1));

  const locations: string[] = [];
  const dropped: string[] = [];
  for (const name of source.locations ?? []) {
    const mapped = mapWordPressLocation(name);
    if (!mapped) dropped.push(name);
    else if (!locations.includes(mapped)) locations.push(mapped);
  }
  const name = normalizeWordPressPlainText(source.name || source.slug || `Menu ${source.id}`).slice(0, 120).trim() || `Menu ${source.id}`;
  return {
    source_id: source.id,
    menu: { id: importedMenuId(source), name, items, ...(locations.length ? { locations } : {}) },
    dropped_locations: dropped,
  };
}

/** A menu still as the new site seeded it: only the home page, no edits. */
export function isStarterMenu(menu: Menu): boolean {
  return menu.items.length === 1 && menu.items[0]!.type === 'page' && menu.items[0]!.page_id === 'home' && !menu.items[0]!.children?.length;
}
