// Client for the Typeroll Helper plugin (wp-helper-plugin/).
//
// When the customer has installed the plugin and provided its API key, this
// client replaces the standard WP REST calls for the data the plugin exposes
// better: custom post types regardless of show_in_rest, ACF fields, full
// featured-image metadata, builder-specific JSON, menu hierarchy.
//
// The migration workflow probes /info on startup; when it succeeds, it
// switches the content-extraction paths to use this client. When the plugin
// is absent or the key is wrong, the migrator falls back to the standard
// WPClient against /wp-json/wp/v2/.

export interface HelperInfo {
  name: string;
  description: string;
  url: string;
  wp_version: string;
  plugin_version: string;
  acf_active: boolean;
  language: string;
  timezone_string?: string;
  site_logo_id?: number;
}

export interface HelperPostType {
  slug: string;
  name: string;
  singular_name: string;
  description: string;
  public: boolean;
  hierarchical: boolean;
  rest_base: string;
  taxonomies: string[];
  is_builtin: boolean;
  count_published: number;
}

export interface HelperMedia {
  id: number;
  url: string;
  alt: string;
  title: string;
  caption: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  filesize: number | null;
  sizes: Record<string, { url: string; width: number | null; height: number | null }>;
}

export interface HelperItem {
  id: number;
  type: string;
  slug: string;
  status: string;
  title: { rendered: string };
  content: { rendered: string; raw: string };
  excerpt: { rendered: string };
  date: string;
  modified: string;
  link: string;
  parent: number;
  menu_order: number;
  author: number;
  featured_image: HelperMedia | null;
  taxonomies: Record<string, Array<{ id: number; name: string; slug: string }>>;
  meta: Record<string, unknown>;
  acf: Record<string, unknown>;
  seo?: HelperPostSEO;
  builder: { kind: string; data: unknown; version?: string } | null;
}

export interface HelperMenu {
  id: number;
  name: string;
  slug: string;
  items: Array<{
    id: number;
    title: string;
    url: string;
    parent: number;
    order: number;
    target: string;
    classes: string[];
  }>;
}

export interface HelperRedirect {
  from: string;
  to: string;
  status_code: number;
  /** Which plugin the redirect came from. */
  source: string;
}

export interface HelperRedirectsResult {
  redirects: HelperRedirect[];
  /** { plugin-key: count } — useful for telling the user where data came from. */
  sources: Record<string, number>;
  total: number;
}

export interface HelperPostmeta {
  post_id: number;
  meta_key: string;
  value: unknown;
  value_decoded: unknown;
  value_type: string;
}

/** Normalized per-post SEO from any of Yoast/RankMath/SEOPress/AIOSEO.
 *  Fields are only present when the source had a value. */
export interface HelperPostSEO {
  title?: string;
  description?: string;
  canonical?: string;
  noindex?: boolean;
  nofollow?: boolean;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  twitter_title?: string;
  twitter_description?: string;
  twitter_image?: string;
  focus_keyword?: string;
}

export interface HelperSiteSEO {
  plugin: 'yoast' | 'rankmath' | 'seopress' | 'aioseo' | 'none';
  site: {
    title_separator?: string | null;
    default_title_format?: string | null;
    default_meta_description?: string | null;
    organization?: {
      name?: string | null;
      logo?: string | null;
      same_as?: string[];
    };
    social?: {
      facebook?: string | null;
      instagram?: string | null;
      linkedin?: string | null;
      twitter?: string | null;
      youtube?: string | null;
    };
    default_og_image?: string | null;
  };
}

export class WPHelperClient {
  private base: string;
  constructor(
    siteUrl: string,
    private apiKey: string
  ) {
    this.base = siteUrl.replace(/\/$/, '') + '/wp-json/typeroll/v1';
  }

  /** Probe the plugin. Returns null on any failure. */
  static async probe(siteUrl: string, apiKey: string): Promise<HelperInfo | null> {
    const client = new WPHelperClient(siteUrl, apiKey);
    try {
      return await client.info();
    } catch {
      return null;
    }
  }

  async info(): Promise<HelperInfo> {
    return this.get<HelperInfo>('/info');
  }

  async postTypes(): Promise<HelperPostType[]> {
    return this.get<HelperPostType[]>('/post-types');
  }

  async listItems(postType: string): Promise<HelperItem[]> {
    return this.paginate<HelperItem>(`/items/${encodeURIComponent(postType)}`);
  }

  async menus(): Promise<HelperMenu[]> {
    return this.get<HelperMenu[]>('/menus');
  }

  /** Every public-facing URL the site emits (used by the inventory step). */
  async urls(): Promise<Array<{ url: string; type: string; id: number; date: string }>> {
    return this.get<Array<{ url: string; type: string; id: number; date: string }>>('/urls');
  }

  /**
   * Existing redirects from whichever redirect plugin the customer is using
   * (301 Redirects, Redirection, Safe Redirect Manager, SEOPress, Yoast
   * Premium). Returns an empty `redirects` array when none of them are
   * installed; callers should treat that as "nothing to import" rather than
   * an error.
   */
  async redirects(): Promise<HelperRedirectsResult> {
    return this.get<HelperRedirectsResult>('/redirects');
  }

  /** Escape hatch: read a single postmeta value. Useful for one-off lookups
   *  when the normalized item shape doesn't expose what you need. */
  async postmeta(postId: number, key: string): Promise<HelperPostmeta> {
    return this.get<HelperPostmeta>(`/postmeta/${postId}/${encodeURIComponent(key)}`);
  }

  /** Site-wide SEO from whichever plugin is active. `{ plugin: 'none', site: {} }`
   *  when no SEO plugin is detected. */
  async seo(): Promise<HelperSiteSEO> {
    return this.get<HelperSiteSEO>('/seo');
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { 'X-Typeroll-Key': this.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Helper ${path} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(`${this.base}${path}?page=${page}&per_page=100`, {
        headers: { 'X-Typeroll-Key': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        throw new Error(`Helper ${path} page ${page} → ${res.status}`);
      }
      const items = (await res.json()) as T[];
      out.push(...items);
      const totalPages = Number(res.headers.get('X-WP-TotalPages') ?? '1');
      if (page >= totalPages || items.length === 0) break;
      page++;
      if (page > 100) break;
    }
    return out;
  }
}
