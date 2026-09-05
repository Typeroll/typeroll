import type { Block } from './types.js';

export interface NavigationLink {
  label: string;
  href: string;
}

function block(id: string, type: string, data: Record<string, unknown>, children?: Block[]): Block {
  return { id: `starter_${id}`, type, data, ...(children ? { children } : {}) };
}

/** Reusable native header/footer trees. Consent remains a site setting. */
export function getPartialCompositionStarter(
  kind: 'header' | 'footer',
  options: { links: NavigationLink[]; navigation_label?: string; menu_label?: string },
): Block[] {
  const navigation = block(`${kind}_navigation`, 'core/navigation', {
    links: options.links,
    aria_label: options.navigation_label ?? (kind === 'header' ? 'Main navigation' : 'Footer navigation'),
    menu_label: options.menu_label ?? 'Menu',
  });
  return [
    block(`${kind}_section`, 'core/section', {
      width: 'wide',
      padding_y: kind === 'header' ? 'sm' : 'lg',
    }, [
      block(`${kind}_layout`, 'core/container', {
        direction: { mobile: 'column', tablet: 'row' },
        align_main: 'space-between',
        align_cross: 'center',
        gap: 'md',
        width: 'wide',
        padding_y: 'none',
        padding_x: 'none',
      }, [
        block(`${kind}_logo`, 'template/site_logo', { height: kind === 'header' ? 'md' : 'sm', link_to_home: true }),
        navigation,
      ]),
    ]),
  ];
}

/** Native archive tree with explicit card semantics and field mappings. */
export function getArchiveCompositionStarter(options: {
  collection: string;
  title: string;
  title_field?: string;
  excerpt_field?: string;
  image_field?: string;
  image_alt_field?: string;
  href_field?: string;
  date_field?: string;
  pdf_url_field?: string;
  pdf_label?: string;
  heading_level?: 'h2' | 'h3' | 'h4';
}): Block[] {
  return [
    block('archive_breadcrumbs', 'template/page_breadcrumbs', { home_label: 'Home', aria_label: 'Breadcrumbs' }),
    block('archive_title', 'core/heading', { text: options.title, level: 'h1', size: '2xl', align: 'left' }),
    block('archive_list', 'core/collection_list', {
      collection: options.collection,
      layout: 'grid',
      cols: { mobile: 1, tablet: 2, desktop: 3 },
      gap: 'lg',
      item_overrides: {
        title_field: options.title_field ?? 'title',
        excerpt_field: options.excerpt_field ?? 'excerpt',
        image_field: options.image_field ?? 'image',
        image_alt_field: options.image_alt_field ?? 'image_alt',
        href_field: options.href_field ?? 'url',
        date_field: options.date_field ?? 'published_at',
        heading_level: options.heading_level ?? 'h2',
        download_url_field: options.pdf_url_field ?? '',
        download_label: options.pdf_label ?? 'Download PDF',
      },
    }),
  ];
}
