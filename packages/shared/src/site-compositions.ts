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
  const links = (id: string, direction: string) => block(id, 'core/navigation_links', {
    links: options.links, direction, gap_px: direction === 'row' ? 24 : 8,
  });
  const navigation: Block = kind === 'header'
    ? { ...block('header_navigation', 'core/navigation_menu', {
      aria_label: options.navigation_label ?? 'Main navigation',
      menu_label: options.menu_label ?? 'Open menu',
    }), slots: [[links('header_desktop_links', 'row')], [links('header_mobile_links', 'column')]] }
    : block('footer_navigation', 'core/container', { tag: 'nav', layout: 'flow', aria_label: options.navigation_label ?? 'Footer navigation' }, [links('footer_links', 'row')]);
  return [block(`${kind}_section`, 'core/section', {
    width: 'wide', padding_y: kind === 'header' ? 'compact' : 'auto',
  }, [block(`${kind}_layout`, 'core/container', {
    direction: kind === 'header' ? 'row' : { mobile: 'column', tablet: 'row' },
    wrap: kind === 'header' ? 'nowrap' : 'wrap', align_main: 'space-between', align_cross: 'center', gap: 'md', width: 'full',
  }, [block(`${kind}_logo`, 'template/site_logo', { height: kind === 'header' ? 'md' : 'sm', link_to_home: true }), navigation])])];
}

/** Native archive tree with explicit card semantics and field mappings. */
export function getArchiveCompositionStarter(options: {
  content_type: string;
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
  return [block('archive_frame', 'core/section', { width: 'wide' }, [
    block('archive_breadcrumbs', 'template/page_breadcrumbs', { home_label: 'Home', aria_label: 'Breadcrumbs' }),
    block('archive_title', 'core/heading', { text: options.title, level: 'h1', size: 'auto', align: 'left' }),
    block('archive_list', 'core/page_list', {
      content_type: options.content_type,
      layout: 'grid',
      responsive_breakpoints: { tablet: 768, laptop: 1024, desktop: 1280, wide: 1536 },
      cols: { mobile: 1, tablet: 2, desktop: 3 },
      gap: 'lg',
      item_overrides: {
        appearance: 'card', whole_card_link: true,
        // A bounded, uncropped archive thumbnail frame keeps portrait media
        // from stretching every card in a row. Ordinary image defaults remain intrinsic.
        image_sizing: 'fixed', image_height_px: 240, image_fit: 'contain',
        title_field: options.title_field ?? 'title',
        excerpt_field: options.excerpt_field ?? 'excerpt',
        image_field: options.image_field ?? 'image',
        image_alt_field: options.image_alt_field ?? 'image_alt',
        href_field: options.href_field ?? 'url',
        date_field: options.date_field ?? 'date_published',
        heading_level: options.heading_level ?? 'h2',
        download_url_field: options.pdf_url_field ?? '',
        download_label: options.pdf_label ?? 'Download PDF',
      },
    }),
  ])];
}
