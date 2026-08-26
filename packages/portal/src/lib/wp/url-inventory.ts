// URL inventory + coverage analysis.
//
// The inventory tracks every URL the old WordPress site had. The migration
// builds it from multiple sources (sitemap, REST, helper plugin, internal
// links from imported pages). The customer reviews the inventory before
// switching DNS to make sure every URL is either migrated or redirected.
//
// Status is COMPUTED at read time from:
//   - current target-site published pages (by slug match)
//   - current redirect rules (by from_path match)
//   - the inventory entry's `excluded` flag
// so it never goes stale.

import { paths, MAIN_VERSION_ID, isRedirectPattern, matchRedirect, sortRedirectsForEmit } from '@typeroll/shared';
import { vstore } from '../version-store';
import type {
  CollectionDef,
  CollectionItem,
  MigrationUrl,
  Page,
  Redirect,
} from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';

export type UrlStatus = 'migrated' | 'redirected' | 'excluded' | 'unhandled';

export interface AnalyzedUrl extends MigrationUrl {
  status: UrlStatus;
  /** When status is migrated or redirected, where the URL resolves on the new site. */
  target?: string;
}

export interface CoverageSummary {
  total: number;
  migrated: number;
  redirected: number;
  excluded: number;
  unhandled: number;
}

// ─── Mutation: add a URL to the inventory (or merge sources) ─────────────

/**
 * Idempotently add an old-site URL to the inventory. If it already exists,
 * merge the source label into the existing entry.
 */
export async function addInventoryUrl(
  store: ReadWriteStore,
  orgId: string,
  siteId: string,
  args: {
    path: string;
    full_url: string;
    source: string;
    gsc_clicks?: number;
    gsc_impressions?: number;
    notes?: string;
  }
): Promise<void> {
  const id = makeUrlId(args.path);
  const docPath = paths.migrationUrl(orgId, siteId, id);
  const existing = await store.getDoc<MigrationUrl>(docPath);

  if (existing) {
    const sources = mergeSources(existing.sources, args.source);
    const patch: Partial<MigrationUrl> = {};
    if (sources.length !== existing.sources.length) patch.sources = sources;
    if (args.gsc_clicks !== undefined && args.gsc_clicks !== existing.gsc_clicks) {
      patch.gsc_clicks = args.gsc_clicks;
    }
    if (args.gsc_impressions !== undefined && args.gsc_impressions !== existing.gsc_impressions) {
      patch.gsc_impressions = args.gsc_impressions;
    }
    if (args.notes !== undefined && args.notes !== existing.notes) patch.notes = args.notes;
    if (Object.keys(patch).length) await store.updateDoc(docPath, patch);
    return;
  }

  const doc: Omit<MigrationUrl, 'id'> = {
    path: args.path,
    full_url: args.full_url,
    sources: [args.source],
    gsc_clicks: args.gsc_clicks,
    gsc_impressions: args.gsc_impressions,
    notes: args.notes,
    found_at: new Date().toISOString(),
  };
  await store.setDoc(docPath, doc);
}

export interface BulkUrlInput {
  /** Absolute URL (preferred — carries the source origin) or a bare path. */
  url: string;
  source?: string;
  gsc_clicks?: number;
  gsc_impressions?: number;
  notes?: string;
  excluded?: boolean;
}

export interface BulkAddResult {
  added: number;
  merged: number;
  /** Inputs that produced no entry, with the reason. Never silent: an
   *  agent that posts 400 sitemap URLs needs to know which 6 were dropped
   *  and why, or it will believe the inventory is complete when it isn't. */
  rejected: Array<{ url: string; reason: string }>;
}

/**
 * Bulk-add URLs to the inventory. This is what makes the inventory usable
 * outside the WordPress migration workflow — an agent walking a sitemap, a
 * CSV of GSC exports, or a crawl of any legacy CMS posts its findings here
 * and then reads coverage back from `analyzeCoverage`.
 *
 * A bare path is accepted as-is; an absolute URL is reduced to its path and
 * kept whole in `full_url`. `source_origin`, when given, additionally
 * rejects absolute URLs from a different origin — the guard that stops a
 * ten-domain multisite migration from pouring domain B's URLs into domain
 * A's inventory (they'd collide on `/kontakt` and read as covered).
 */
export async function addInventoryUrls(
  store: ReadWriteStore,
  orgId: string,
  siteId: string,
  urls: BulkUrlInput[],
  opts: { defaultSource?: string; sourceOrigin?: string } = {},
): Promise<BulkAddResult> {
  const result: BulkAddResult = { added: 0, merged: 0, rejected: [] };
  const defaultSource = opts.defaultSource || 'import';
  for (const input of urls) {
    const raw = typeof input?.url === 'string' ? input.url.trim() : '';
    if (!raw) {
      result.rejected.push({ url: String(input?.url ?? ''), reason: 'empty url' });
      continue;
    }
    let path: string | null;
    let fullUrl = raw;
    if (raw.startsWith('/')) {
      path = normalizePath(raw);
      if (opts.sourceOrigin) {
        try {
          fullUrl = new URL(path, opts.sourceOrigin).toString();
        } catch {
          /* keep the bare path as full_url */
        }
      }
    } else if (opts.sourceOrigin) {
      path = pathFromUrl(raw, opts.sourceOrigin);
      if (!path) {
        result.rejected.push({ url: raw, reason: 'different origin than source_origin' });
        continue;
      }
    } else {
      try {
        const u = new URL(raw);
        path = normalizePath(u.pathname + (u.search || ''));
      } catch {
        result.rejected.push({ url: raw, reason: 'not a path or absolute URL' });
        continue;
      }
    }

    const id = makeUrlId(path);
    const existed = await store.getDoc<MigrationUrl>(paths.migrationUrl(orgId, siteId, id));
    await addInventoryUrl(store, orgId, siteId, {
      path,
      full_url: fullUrl,
      source: input.source || defaultSource,
      gsc_clicks: input.gsc_clicks,
      gsc_impressions: input.gsc_impressions,
      notes: input.notes,
    });
    if (input.excluded !== undefined) {
      await store.updateDoc(paths.migrationUrl(orgId, siteId, id), { excluded: input.excluded });
    }
    if (existed) result.merged++;
    else result.added++;
  }
  return result;
}

/** Coerce an absolute or relative URL onto a relative path against `sourceOrigin`. */
export function pathFromUrl(url: string, sourceOrigin: string): string | null {
  try {
    if (url.startsWith('/')) return normalizePath(url);
    const u = new URL(url);
    const o = new URL(sourceOrigin);
    if (u.origin !== o.origin) return null;
    return normalizePath(u.pathname + (u.search || ''));
  } catch {
    return null;
  }
}

function normalizePath(p: string): string {
  // Trim trailing slash except for root.
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  // Decode common encoded chars so duplicates collapse.
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

export function makeUrlId(path: string): string {
  // Filesystem-safe id. The fixtures store needs this; Firestore tolerates
  // most chars but we keep the convention uniform.
  return (
    path
      .replace(/^\//, '')
      .replace(/[\/\\]/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 100) || 'root'
  );
}

function mergeSources(existing: string[], add: string): string[] {
  if (existing.includes(add)) return existing;
  return [...existing, add];
}

// ─── Read: analyze coverage on demand ────────────────────────────────────

/**
 * Pull the inventory + the target site's pages + redirects and classify
 * every URL. Pure function over current state — call this on every
 * dashboard load so the data is never stale.
 */
export async function analyzeCoverage(
  store: ReadWriteStore,
  orgId: string,
  siteId: string
): Promise<{ urls: AnalyzedUrl[]; summary: CoverageSummary }> {
  const [inventory, pages, redirects, collections] = await Promise.all([
    store.listDocs<MigrationUrl>(paths.migrationUrls(orgId, siteId)),
    await vstore.pages(orgId, siteId, MAIN_VERSION_ID),
    await vstore.redirects(orgId, siteId, MAIN_VERSION_ID),
    store.listDocs<CollectionDef>(paths.collections(orgId, siteId, MAIN_VERSION_ID)),
  ]);

  // Build lookup tables once. Pages are matched on the *resolved* URL
  // (Page.path when set, otherwise "/" + slug) so nested pages opted
  // into via path are classified as migrated, not unhandled. See
  // docs/page-path-plan.md for the field model.
  const pageByUrl = new Map<string, Page>();
  for (const p of pages) {
    if (p.status !== 'published' && p.status !== 'unlisted') continue;
    const resolvedUrl = (typeof p.path === 'string' && p.path.length > 0)
      ? p.path
      : (p.slug === 'home' || p.slug === '' || p.slug === 'index' ? '/' : `/${p.slug.replace(/^\//, '')}`);
    pageByUrl.set(normalizePath(resolvedUrl), p);
    if (p.slug === 'home') pageByUrl.set('/', p);
    if (p.old_wp_url) {
      try {
        const u = new URL(p.old_wp_url);
        pageByUrl.set(normalizePath(u.pathname), p);
      } catch {
        /* ignore */
      }
    }
  }

  // Collection items with a route_template materialise as static pages too
  // — index them by URL so the coverage analyzer doesn't classify migrated
  // posts (now imported as items in a `posts` collection, per
  // docs/page-slug-audit.md) as unhandled. Items are matched by their
  // resolved URL, by their slug_field value, and by their old_wp_url
  // field when populated (the migration sets this for every imported
  // post). Same matching surface as pages, just sourced from a
  // collection.
  const itemUrlInfo = new Map<string, { url: string; status: string }>();
  for (const coll of collections) {
    const tpl = coll.route_template;
    if (!tpl || tpl === '') continue;
    const slugField = coll.slug_field ?? 'slug';
    const items = await store.listDocs<CollectionItem>(
      paths.collectionItems(orgId, siteId, coll.name, MAIN_VERSION_ID),
    );
    for (const item of items) {
      if (item.status !== 'published') continue;
      const slugVal = item[slugField];
      if (typeof slugVal !== 'string' || !slugVal) continue;
      // The renderer's resolver supports `{slug}` and `{date:YYYY/MM}` —
      // we only inline `{slug_field}` here. Templates with date tokens
      // remain unresolved for coverage purposes; their items still match
      // via old_wp_url when present.
      const url = tpl.replace(`{${slugField}}`, slugVal);
      if (url.includes('{')) {
        // Unresolved token — skip URL match, rely on old_wp_url path.
      } else {
        itemUrlInfo.set(normalizePath(url), { url, status: 'migrated' });
      }
      const oldWp = item.old_wp_url;
      if (typeof oldWp === 'string' && oldWp) {
        try {
          const u = new URL(oldWp);
          itemUrlInfo.set(normalizePath(u.pathname), {
            url: url.includes('{') ? oldWp : url,
            status: 'migrated',
          });
        } catch {
          /* ignore */
        }
      }
    }
  }

  const redirectByFrom = new Map<string, Redirect>();
  const patternRules: Redirect[] = [];
  for (const r of redirects) {
    if (isRedirectPattern(r.from_path)) patternRules.push(r);
    else redirectByFrom.set(normalizePath(r.from_path), r);
  }
  // Same order the deploy emits, so the report predicts production rather
  // than a second opinion about it: most specific first, first match wins.
  const orderedPatterns = sortRedirectsForEmit(patternRules);

  const urls: AnalyzedUrl[] = inventory.map((entry) => {
    const path = normalizePath(entry.path);
    let status: UrlStatus;
    let target: string | undefined;

    if (entry.excluded) {
      status = 'excluded';
    } else if (pageByUrl.has(path)) {
      status = 'migrated';
      const page = pageByUrl.get(path)!;
      // Resolved URL = Page.path when set, else "/" + slug. Same shape
      // the renderer uses (urlFor / pageUrlFromDoc).
      target = (typeof page.path === 'string' && page.path.length > 0)
        ? page.path
        : (page.slug === 'home' ? '/' : `/${page.slug.replace(/^\//, '')}`);
    } else if (itemUrlInfo.has(path)) {
      status = 'migrated';
      target = itemUrlInfo.get(path)!.url;
    } else if (redirectByFrom.has(path)) {
      status = 'redirected';
      target = redirectByFrom.get(path)!.to_path;
    } else {
      // Wildcard rules: one `/category/*` can cover hundreds of inventory
      // entries. Without this they'd all report `unhandled` and the work
      // list would never empty even though the migration is done.
      const hit = matchPatternRule(orderedPatterns, path);
      if (hit) {
        status = 'redirected';
        target = hit;
      } else {
        status = 'unhandled';
      }
    }
    return { ...entry, status, target };
  });

  // Sort: unhandled first (most actionable), then by GSC clicks desc.
  urls.sort((a, b) => {
    const sa = statusRank(a.status);
    const sb = statusRank(b.status);
    if (sa !== sb) return sa - sb;
    const ca = a.gsc_clicks ?? 0;
    const cb = b.gsc_clicks ?? 0;
    if (ca !== cb) return cb - ca;
    return a.path.localeCompare(b.path);
  });

  const summary: CoverageSummary = {
    total: urls.length,
    migrated: 0,
    redirected: 0,
    excluded: 0,
    unhandled: 0,
  };
  for (const u of urls) {
    summary[u.status]++;
  }

  return { urls, summary };
}

/** First matching pattern rule wins, mirroring Cloudflare's top-down scan. */
function matchPatternRule(rules: Redirect[], path: string): string | null {
  for (const r of rules) {
    const resolved = matchRedirect(r.from_path, r.to_path, path);
    if (resolved !== null) return resolved;
  }
  return null;
}

function statusRank(s: UrlStatus): number {
  switch (s) {
    case 'unhandled':  return 0;
    case 'redirected': return 1;
    case 'migrated':   return 2;
    case 'excluded':   return 3;
  }
}
