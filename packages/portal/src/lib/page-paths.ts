// Page URL routing helpers — shared by every write surface that touches
// the `path` field on Page docs (v1 POST/PATCH, in-portal chat, MCP).
//
// Background: Page.slug is a single URL segment ("about", "contact").
// Page.path is the optional explicit full URL ("/erbjudanden/sommar-2026")
// — when set, it wins for routing; when unset, the renderer falls back
// to "/" + slug. The two-field model lets slug stay an unambiguous leaf
// id while path carries the routing intent. See docs/page-path-plan.md.

import type { Page } from '@typeroll/shared';

export type PathValidation =
  | { ok: true; path: string }    // path === '' means "not provided"
  | { ok: false; error: string };

/**
 * Normalise + validate a `path` field value on a write request.
 *
 *  - Returns `{ ok: true, path: '' }` when the input is undefined / null /
 *    empty — the caller leaves `path` off the doc and the renderer falls
 *    back to "/" + slug.
 *  - Otherwise the path must start with `/`, use only lowercase
 *    ASCII letters / digits / `-` / `_` / `/`, contain no `..` / `.`
 *    segments, no `//`, no trailing `/` (except the bare `/` homepage),
 *    and be ≤ 200 chars.
 *  - The homepage opts in by passing `path: '/'`. Setting `path: ''` is
 *    treated as "not provided" so callers don't have to send the field.
 */
export function validatePathField(raw: unknown): PathValidation {
  if (raw === undefined || raw === null || raw === '') return { ok: true, path: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'path must be a string' };
  if (raw.length > 200) return { ok: false, error: 'path is longer than 200 chars' };
  if (!raw.startsWith('/')) return { ok: false, error: 'path must start with "/"' };
  if (raw !== '/' && raw.endsWith('/')) {
    return { ok: false, error: 'path must not end with "/" (except the bare "/" homepage)' };
  }
  if (raw.includes('//')) return { ok: false, error: 'path must not contain "//"' };
  if (raw.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, error: 'path must not contain "." or ".." segments' };
  }
  if (!/^\/[a-z0-9_\-/]*$/.test(raw)) {
    return { ok: false, error: 'path may only contain lowercase letters, digits, "-", "_" and "/"' };
  }
  return { ok: true, path: raw };
}

/**
 * Resolve the live URL path for a page doc. When `path` is set, it's
 * authoritative; otherwise we fall back to "/" + slug (preserving every
 * pre-`path` page's URL).
 */
export function pageUrlFromDoc(p: Pick<Page, 'slug' | 'path'>): string {
  if (typeof p.path === 'string' && p.path.length > 0) return p.path;
  if (!p.slug || p.slug === 'home' || p.slug === 'index') return '/';
  return p.slug.startsWith('/') ? p.slug : `/${p.slug}`;
}

/**
 * Datastore doc id derived from a URL path. Slashes become underscores so
 * Firestore doesn't read the id as a nested collection (the trick the
 * migration code uses). Top-level slug-only pages reduce to just the
 * slug — back-compat with every existing page id.
 */
export function makeSafePageId(urlPath: string): string {
  const trimmed = urlPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'home';
  return trimmed.replace(/\//g, '_').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'page';
}
