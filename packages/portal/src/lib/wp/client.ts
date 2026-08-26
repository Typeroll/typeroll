// Minimal WordPress REST API client.
//
// All endpoints under /wp-json/wp/v2/* are public on most sites, so we use
// unauthenticated GETs for the read-only migration flow. Pagination is
// followed automatically via the X-WP-TotalPages header.

export interface WPPage {
  id: number;
  slug: string;
  status: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt?: { rendered: string };
  link: string;
  date: string;
  modified: string;
  parent?: number;
  menu_order?: number;
  featured_media?: number;
  /** ACF fields, present when the site exposes them. */
  acf?: Record<string, unknown>;
  /** Native post_meta exposed via register_post_meta(..., 'show_in_rest' => true). */
  meta?: Record<string, unknown>;
  yoast_head_json?: {
    title?: string;
    description?: string;
    canonical?: string;
    og_image?: Array<{ url: string }>;
    schema?: unknown;
  };
}

export interface WPPost extends WPPage {
  categories?: number[];
  tags?: number[];
}

/** Catch-all for items of arbitrary post types (custom or built-in). */
export interface WPItem extends WPPage {
  type?: string;
  [key: string]: unknown;
}

/** Result of GET /wp-json/wp/v2/types — the index of all post types. */
export interface WPPostType {
  slug: string;
  name: string;
  description?: string;
  rest_base: string;
  rest_namespace?: string;
  taxonomies?: string[];
  /** Builtin types: post, page, attachment, nav_menu_item, etc. */
  hierarchical?: boolean;
}

export interface WPMedia {
  id: number;
  source_url: string;
  alt_text?: string;
  mime_type?: string;
  media_details?: {
    width?: number;
    height?: number;
    sizes?: Record<string, { source_url: string; width: number; height: number }>;
    filesize?: number;
  };
}

export interface WPMenuItem {
  id: number;
  title: { rendered: string };
  url: string;
  parent: number;
  menu_order: number;
}

export interface WPSiteInfo {
  name: string;
  description: string;
  home: string;
  url: string;
  site_logo?: number;
  site_icon?: number;
  site_icon_url?: string;
}

export class WPClient {
  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': 'Typeroll-Migrator/0.1', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
    return (await res.json()) as T;
  }

  async siteInfo(): Promise<WPSiteInfo> {
    return this.fetchJSON<WPSiteInfo>('/wp-json/');
  }

  async listPages(): Promise<WPPage[]> {
    return this.paginate<WPPage>('/wp-json/wp/v2/pages?status=publish&per_page=100');
  }

  async listPosts(): Promise<WPPost[]> {
    return this.paginate<WPPost>('/wp-json/wp/v2/posts?status=publish&per_page=100');
  }

  /**
   * List every registered post type. Builtin types (post, page, attachment,
   * wp_block, etc.) are filtered out — callers want the CUSTOM ones to map
   * onto Typeroll collections.
   */
  async listCustomPostTypes(): Promise<WPPostType[]> {
    let typesObj: Record<string, WPPostType>;
    try {
      typesObj = await this.fetchJSON<Record<string, WPPostType>>('/wp-json/wp/v2/types');
    } catch {
      return [];
    }
    const BUILTIN = new Set([
      'post', 'page', 'attachment', 'nav_menu_item', 'wp_block',
      'wp_template', 'wp_template_part', 'wp_navigation', 'wp_global_styles',
      'revision', 'oembed_cache', 'user_request',
    ]);
    return Object.values(typesObj).filter((t) => t.slug && !BUILTIN.has(t.slug) && t.rest_base);
  }

  /** Fetch items of a specific (custom) post type by its REST base. */
  async listItemsOfType(restBase: string): Promise<WPItem[]> {
    return this.paginate<WPItem>(`/wp-json/wp/v2/${restBase}?status=publish&per_page=100`);
  }

  async listMedia(): Promise<WPMedia[]> {
    return this.paginate<WPMedia>('/wp-json/wp/v2/media?per_page=100');
  }

  async getMedia(id: number): Promise<WPMedia | null> {
    if (!id) return null;
    try {
      return await this.fetchJSON<WPMedia>(`/wp-json/wp/v2/media/${id}`);
    } catch {
      return null;
    }
  }

  /**
   * Fetch many media items by id in a single REST call.
   * Useful for inlining featured images at bulk-import time.
   */
  async getMediaBatch(ids: number[]): Promise<Map<number, WPMedia>> {
    const out = new Map<number, WPMedia>();
    if (!ids.length) return out;
    const unique = Array.from(new Set(ids.filter((n) => n > 0)));
    if (!unique.length) return out;
    try {
      const items = await this.paginate<WPMedia>(
        `/wp-json/wp/v2/media?include=${unique.join(',')}&per_page=100`
      );
      for (const m of items) out.set(m.id, m);
    } catch {
      // Fall back to per-id fetches if the batch endpoint chokes.
      for (const id of unique) {
        const m = await this.getMedia(id);
        if (m) out.set(id, m);
      }
    }
    return out;
  }

  async listMenus(): Promise<Array<{ id: number; name: string; slug: string }>> {
    try {
      return await this.fetchJSON('/wp-json/wp/v2/menus');
    } catch {
      return [];
    }
  }

  async listMenuItems(menuId: number): Promise<WPMenuItem[]> {
    try {
      return await this.paginate<WPMenuItem>(`/wp-json/wp/v2/menu-items?menus=${menuId}&per_page=100`);
    } catch {
      return [];
    }
  }

  /** Download a remote asset as a Buffer (for media). */
  async download(url: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    let page = 1;
    while (true) {
      const url = `${this.baseUrl}${path}${sep}page=${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Typeroll-Migrator/0.1' },
      });
      if (res.status === 400) break; // common: "rest_post_invalid_page_number"
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
      const items = (await res.json()) as T[];
      out.push(...items);
      const totalPages = Number(res.headers.get('X-WP-TotalPages') ?? '1');
      if (page >= totalPages || items.length === 0) break;
      page++;
      if (page > 50) break; // sanity cap
    }
    return out;
  }
}
