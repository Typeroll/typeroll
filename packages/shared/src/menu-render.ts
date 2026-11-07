/**
 * Site menus inside a `core/navigation_links` block (render version 15): the
 * renderer's side of menus.ts. A block with `source: "menu"` names a menu by
 * id or `location:<name>`; the menu is resolved against the site's pages for
 * the current page and rendered with its submenus.
 */
import { findMenu, renderMenuItems, resolveMenu, type Menu, type MenuPage, type SubmenuDisplay } from './menus.js';
import { linkTargetAttributes } from './link-attributes.js';
import { renderIconHtml } from './icons.js';
import { uiText } from './ui-text.js';
import type { Block } from './types.js';

/** The menus a render can show, with what they need to know about pages. */
export interface MenuSource {
  menus: Menu[];
  /**
   * The site's published pages as menus see them. Without it the renderer
   * builds the list from `pageSource`. A static build passes its own list so
   * the render cache records one dependency on the menu-relevant page fields
   * instead of on every page record.
   */
  pages?: () => MenuPage[];
  /** Items left out and menus that do not exist. */
  onWarning?: (message: string) => void;
}

type PageSource = (config: Record<string, never>) => Record<string, unknown>[];

const text = (value: unknown) => typeof value === 'string' ? value : '';

/** What menus need from a page record of `createPageSource` (published pages with an address). */
export function menuPageFromRecord(page: Record<string, unknown>): MenuPage | null {
  const path = text(page.url) || text(page.path);
  if (!text(page.id) || !path) return null;
  return {
    id: text(page.id),
    title: text(page.title),
    path,
    parent: text(page.parent) || null,
    sort_order: typeof page.sort_order === 'number' ? page.sort_order : null,
    breadcrumb_label: text(page.breadcrumb_label) || null,
    status: 'published',
  };
}

/** Menu pages from a page source: every published page with an address. */
export function menuPagesFromSource(pageSource: PageSource | undefined): MenuPage[] {
  if (!pageSource) return [];
  return pageSource({}).map(menuPageFromRecord).filter((page): page is MenuPage => !!page);
}

const DISPLAYS: readonly SubmenuDisplay[] = ['dropdown', 'accordion', 'expanded', 'none'];

/**
 * How submenus open. `auto` is a dropdown in a row of links and an accordion
 * in a column; for a responsive direction the widest screen decides, since
 * small screens show the header links in the menu dialog, where a dropdown
 * opens in place anyway.
 */
export function submenuDisplay(value: unknown, direction: unknown): SubmenuDisplay {
  if (DISPLAYS.includes(value as SubmenuDisplay)) return value as SubmenuDisplay;
  let resolved = direction;
  if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
    const values = Object.values(resolved as Record<string, unknown>).filter(entry => typeof entry === 'string');
    resolved = values[values.length - 1];
  }
  return resolved === 'row' ? 'dropdown' : 'accordion';
}

/** True for a block that shows a site menu (render version 15). */
export function isMenuNavigation(block: Pick<Block, 'type' | 'data'>): boolean {
  return block.type === 'core/navigation_links' && block.data?.source === 'menu';
}

/** True when a tree has a menu-sourced navigation block whose submenus need the runtime. */
export function usesMenuSubmenus(blocks: readonly Block[]): boolean {
  return blocks.some(block => (isMenuNavigation(block) && !['none', 'expanded'].includes(String(block.data?.submenus ?? 'auto')))
    || usesMenuSubmenus(block.children ?? []) || (block.slots ?? []).some(usesMenuSubmenus));
}

export interface MenuNavigationResult { html: string; submenus: boolean }

/** List items for a menu-sourced block on one page. A missing menu renders no items. */
export function renderMenuNavigation(
  block: Pick<Block, 'id' | 'data'>,
  source: MenuSource | undefined,
  options: { currentPath: string; language: unknown; pageSource?: PageSource },
): MenuNavigationResult {
  const reference = text(block.data?.menu).trim();
  const menu = findMenu(source?.menus, reference);
  if (!menu) {
    source?.onWarning?.(reference
      ? `A Navigation links block (${block.id}) shows the menu "${reference}", which does not exist; it renders no links.`
      : `A Navigation links block (${block.id}) shows a site menu but names none; it renders no links.`);
    return { html: '', submenus: false };
  }
  const pages = source?.pages ? source.pages() : menuPagesFromSource(options.pageSource);
  const resolved = resolveMenu(menu, pages, options.currentPath);
  for (const warning of resolved.warnings) source?.onWarning?.(warning);
  const display = submenuDisplay(block.data?.submenus, block.data?.direction);
  const toggleText = uiText(options.language, 'show_submenu');
  const html = renderMenuItems(resolved.items, {
    idPrefix: `nav-${block.id}`,
    display,
    withIcons: true,
    renderIcon: renderIconHtml,
    linkAttributes: rel => linkTargetAttributes(rel, false),
    toggleLabel: label => toggleText.replace('{label}', label),
  });
  return { html, submenus: html.includes(' data-submenu="') };
}
