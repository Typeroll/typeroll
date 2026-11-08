/**
 * Menus: named trees of links a site keeps once and shows in several places
 * (WordPress-style menus with locations). A `core/navigation_links` block with
 * `source: "menu"` renders one by id or location. Page items link by page id,
 * so labels and addresses follow renames; a page's children can make a
 * submenu by themselves; new top-level pages can be added automatically.
 * See docs/plans/fonts-menus-fields-snippets-templates.md.
 */
const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export type MenuItemType = 'page' | 'url' | 'children' | 'heading';

export interface MenuItem {
  id: string;
  type: MenuItemType;
  /** `page` and `children`: the page linked to, or whose children are listed. */
  page_id?: string;
  /** `url`: an address, path or anchor. */
  href?: string;
  /** Overrides the page's title (`page`); required for `url` and `heading`. */
  label?: string;
  /** A short line under the label in wide submenus. */
  description?: string;
  icon?: string;
  link_rel?: string;
  children?: MenuItem[];
}

export interface Menu {
  id: string;
  name: string;
  /** Places this menu fills, e.g. `primary`, `footer`, `mobile`. Unique per site. */
  locations?: string[];
  /** New top-level published pages are appended to the end automatically. */
  auto_add_pages?: boolean;
  items: MenuItem[];
  created_at?: string;
  updated_at?: string;
}

export const MENU_LOCATIONS = ['primary', 'footer', 'mobile'] as const;
export const MAX_MENU_DEPTH = 3;
export const MAX_MENU_ITEMS = 200;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LOCATION = /^[a-z][a-z0-9_-]{0,39}$/;

export interface MenuValidationError { path: string; message: string }

/** Checks a menu's shape; returns every problem with its path. */
export function validateMenu(input: unknown): { menu: Menu | null; errors: MenuValidationError[] } {
  const errors: MenuValidationError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { menu: null, errors: [{ path: '', message: 'A menu is an object' }] };
  const raw = input as Record<string, unknown>;
  const id = String(raw.id ?? '');
  if (!ID.test(id)) add('id', 'Use lowercase letters, digits, hyphens and underscores (at most 64)');
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 120) add('name', 'Give the menu a name (at most 120 characters)');
  const locations = Array.isArray(raw.locations) ? raw.locations.map(String) : [];
  locations.forEach((location, index) => { if (!LOCATION.test(location)) add(`locations[${index}]`, 'Use a short lowercase name such as primary or footer'); });
  if (new Set(locations).size !== locations.length) add('locations', 'A location is listed twice');
  let count = 0;
  const ids = new Set<string>();
  const item = (value: unknown, path: string, depth: number): MenuItem | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { add(path, 'A menu item is an object'); return null; }
    const entry = value as Record<string, unknown>;
    if (++count > MAX_MENU_ITEMS) { if (count === MAX_MENU_ITEMS + 1) add(path, `A menu has at most ${MAX_MENU_ITEMS} items`); return null; }
    const type = String(entry.type ?? '') as MenuItemType;
    if (!['page', 'url', 'children', 'heading'].includes(type)) add(`${path}.type`, 'Use page, url, children or heading');
    const itemId = String(entry.id ?? '');
    if (!ID.test(itemId)) add(`${path}.id`, 'Give the item an id (lowercase letters, digits, - and _)');
    else if (ids.has(itemId)) add(`${path}.id`, 'Item ids must be unique in the menu');
    ids.add(itemId);
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (label.length > 120) add(`${path}.label`, 'At most 120 characters');
    if ((type === 'page' || type === 'children') && !String(entry.page_id ?? '').trim()) add(`${path}.page_id`, 'Choose the page');
    if (type === 'url') {
      const href = String(entry.href ?? '').trim();
      if (!href) add(`${path}.href`, 'Give the address');
      else if (/^\s*(javascript|data|vbscript):/i.test(href)) add(`${path}.href`, 'This kind of address is not allowed');
      if (!label) add(`${path}.label`, 'Give the link a label');
    }
    if (type === 'heading' && !label) add(`${path}.label`, 'Give the heading a label');
    const children = Array.isArray(entry.children) ? entry.children : [];
    if (children.length && depth >= MAX_MENU_DEPTH) add(`${path}.children`, `Menus are at most ${MAX_MENU_DEPTH} levels deep`);
    if (children.length && type === 'children') add(`${path}.children`, 'A page-children item lists its pages by itself');
    const out: MenuItem = { id: itemId, type };
    for (const key of ['page_id', 'href', 'description', 'icon', 'link_rel'] as const)
      if (typeof entry[key] === 'string' && entry[key].trim()) out[key] = (entry[key] as string).trim();
    if (label) out.label = label;
    if (out.description && out.description.length > 200) add(`${path}.description`, 'At most 200 characters');
    const kept = depth < MAX_MENU_DEPTH ? children.map((child, index) => item(child, `${path}.children[${index}]`, depth + 1)).filter((child): child is MenuItem => !!child) : [];
    if (kept.length) out.children = kept;
    return out;
  };
  const items = Array.isArray(raw.items) ? raw.items.map((value, index) => item(value, `items[${index}]`, 1)).filter((value): value is MenuItem => !!value) : [];
  if (!Array.isArray(raw.items)) add('items', 'items is a list');
  const menu: Menu = { id, name, items, ...(locations.length ? { locations } : {}), ...(raw.auto_add_pages === true ? { auto_add_pages: true } : {}) };
  for (const key of ['created_at', 'updated_at'] as const) if (typeof raw[key] === 'string') menu[key] = raw[key] as string;
  return { menu: errors.length ? null : menu, errors };
}

/** Locations taken by more than one menu. */
export function locationConflicts(menus: Menu[]): string[] {
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const menu of menus) for (const location of menu.locations ?? []) {
    if (seen.has(location) && seen.get(location) !== menu.id) conflicts.add(location);
    seen.set(location, menu.id);
  }
  return [...conflicts];
}

/** What a menu needs to know about a page at build time. */
export interface MenuPage {
  id: string;
  title: string;
  path: string;
  parent?: string | null;
  sort_order?: number | null;
  status?: string;
  breadcrumb_label?: string | null;
}

export interface ResolvedMenuItem {
  id: string;
  label: string;
  href: string | null;
  description?: string;
  icon?: string;
  link_rel?: string;
  current: boolean;
  /** The current page is somewhere below this item. */
  current_ancestor: boolean;
  children: ResolvedMenuItem[];
}

export interface ResolveResult { items: ResolvedMenuItem[]; warnings: string[] }

const normalizePath = (value: string) => {
  try {
    const path = new URL(value, 'https://typeroll.invalid').pathname;
    return path === '/' ? '/' : path.replace(/\/+$/, '');
  } catch { return value; }
};
const visible = (page: MenuPage | undefined): page is MenuPage => !!page && (page.status === undefined || page.status === 'published');
const byOrder = (a: MenuPage, b: MenuPage) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.title.localeCompare(b.title);
const pageLabel = (page: MenuPage) => (page.breadcrumb_label ?? '').trim() || page.title;

/**
 * Turns a menu into links for one page: page items take the page's current
 * title and address, unpublished or deleted pages drop out (with a warning),
 * `children` items list the page's published children, and the current page
 * and its ancestors are marked.
 */
export function resolveMenu(menu: Menu, pages: MenuPage[], currentPath: string): ResolveResult {
  const warnings: string[] = [];
  const byId = new Map(pages.map((page) => [page.id, page]));
  const current = normalizePath(currentPath || '/');
  const fromPage = (page: MenuPage, id: string, children: ResolvedMenuItem[] = []): ResolvedMenuItem => ({
    id, label: pageLabel(page), href: page.path, current: normalizePath(page.path) === current, current_ancestor: false, children,
  });
  const resolve = (item: MenuItem, depth: number): ResolvedMenuItem[] => {
    const children = (item.children ?? []).flatMap((child) => resolve(child, depth + 1));
    let resolved: ResolvedMenuItem | null = null;
    if (item.type === 'page') {
      const page = byId.get(item.page_id ?? '');
      if (!visible(page)) { warnings.push(`Menu "${menu.name}": item ${item.id} links to a page that is missing or not published; it is left out.`); return children; }
      resolved = { ...fromPage(page, item.id, children), label: item.label || pageLabel(page) };
    } else if (item.type === 'children') {
      const parent = byId.get(item.page_id ?? '');
      if (!visible(parent)) { warnings.push(`Menu "${menu.name}": item ${item.id} lists the children of a page that is missing or not published.`); return []; }
      const kids = pages.filter((page) => page.parent === parent.id && visible(page)).sort(byOrder).map((page) => fromPage(page, `${item.id}-${page.id}`));
      // With a label the children become a submenu under it; without, they sit in place.
      if (!item.label) return kids;
      resolved = { id: item.id, label: item.label, href: parent.path, current: normalizePath(parent.path) === current, current_ancestor: false, children: kids };
    } else if (item.type === 'url') {
      const href = item.href ?? '';
      let target = '';
      try { target = new URL(href, 'https://typeroll.invalid/').origin === 'https://typeroll.invalid' ? normalizePath(href) : ''; } catch { /* external */ }
      resolved = { id: item.id, label: item.label ?? href, href, current: !!target && !href.startsWith('#') && target === current, current_ancestor: false, children };
    } else {
      resolved = { id: item.id, label: item.label ?? '', href: null, current: false, current_ancestor: false, children };
    }
    for (const key of ['description', 'icon', 'link_rel'] as const) if (item[key]) resolved[key] = item[key];
    resolved.current_ancestor = resolved.children.some((child) => child.current || child.current_ancestor);
    return [resolved];
  };
  const items = menu.items.flatMap((item) => resolve(item, 1));
  if (menu.auto_add_pages) {
    const linked = new Set<string>();
    const walk = (list: MenuItem[]) => list.forEach((item) => { if (item.page_id) linked.add(item.page_id); walk(item.children ?? []); });
    walk(menu.items);
    for (const page of pages.filter((page) => !page.parent && visible(page) && !linked.has(page.id) && normalizePath(page.path) !== '/').sort(byOrder))
      items.push(fromPage(page, `auto-${page.id}`));
  }
  return { items, warnings };
}

/** The menu a block refers to: by id, or `location:<name>`. */
export function findMenu(menus: Menu[] | undefined, reference: string): Menu | undefined {
  const ref = reference.trim();
  if (!ref || !menus?.length) return undefined;
  if (ref.startsWith('location:')) {
    const location = ref.slice('location:'.length);
    return menus.find((menu) => menu.locations?.includes(location));
  }
  return menus.find((menu) => menu.id === ref);
}

export type SubmenuDisplay = 'dropdown' | 'accordion' | 'expanded' | 'none';

export interface MenuHtmlOptions {
  /** Unique per block on the page; prefixes submenu ids. */
  idPrefix: string;
  display: SubmenuDisplay;
  withIcons: boolean;
  renderIcon: (name: string) => string;
  linkAttributes: (linkRel: unknown) => string;
  /** The accessible label of a submenu button, e.g. "Show the submenu: {label}". */
  toggleLabel: (label: string) => string;
}

/**
 * List items for a resolved menu. Submenus are nested lists with a button
 * that opens them (disclosure navigation): without script, `dropdown` opens
 * on hover and focus, `accordion` shows everything, and `expanded` always
 * shows the children. A submenu whose items have children of their own is
 * laid out in columns (a wide menu).
 */
export function renderMenuItems(items: ResolvedMenuItem[], options: MenuHtmlOptions, depth = 1): string {
  return items.map((item) => {
    const label = escapeHtml(item.label);
    const icon = options.withIcons && item.icon ? `<span class="block-nav-icon" aria-hidden="true">${options.renderIcon(item.icon)}</span>` : '';
    const text = icon ? `${icon}<span>${label}</span>` : label;
    const description = item.description && depth > 1 ? `<span class="block-nav-description">${escapeHtml(item.description)}</span>` : '';
    const current = item.current ? ' aria-current="page"' : '';
    const link = item.href !== null
      ? `<a href="${escapeHtml(item.href)}"${current}${options.linkAttributes(item.link_rel)}>${description ? `<span class="block-nav-text">${text}${description}</span>` : text}</a>`
      : '';
    const showChildren = item.children.length > 0 && options.display !== 'none';
    if (!showChildren) {
      return item.href !== null ? `<li>${link}</li>` : `<li class="block-nav-heading"><span>${text}</span></li>`;
    }
    const subId = `${options.idPrefix}-${item.id}`;
    const wide = item.children.some((child) => child.children.length > 0);
    const sub = `<ul class="block-nav-sub${wide ? ' block-nav-sub--columns' : ''}" id="${escapeHtml(subId)}">${renderMenuItems(item.children, options, depth + 1)}</ul>`;
    const classes = `block-nav-parent${item.current_ancestor ? ' block-nav-parent--current' : ''}`;
    if (options.display === 'expanded' || depth > 1) {
      // Inside a submenu, or when everything is shown, children are a plain nested list.
      const head = item.href !== null ? link : `<span class="block-nav-heading">${text}</span>`;
      return `<li class="${classes}">${head}${sub}</li>`;
    }
    // A heading without a link opens its submenu with the label itself.
    const toggle = item.href !== null
      ? `<button type="button" class="block-nav-toggle" aria-expanded="false" aria-controls="${escapeHtml(subId)}"><span class="block-nav-sr">${escapeHtml(options.toggleLabel(item.label))}</span></button>`
      : `<button type="button" class="block-nav-toggle block-nav-toggle--label" aria-expanded="false" aria-controls="${escapeHtml(subId)}">${text}</button>`;
    return `<li class="${classes}" data-submenu="${options.display}">${link}${toggle}${sub}</li>`;
  }).join('');
}
