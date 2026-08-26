// Shared write-path guard for redirect rules.
//
// Three surfaces create redirects (v1 REST, the portal form, the chat AI)
// and each used to do its own `from_path.replace(...)` id derivation and no
// validation at all. That was survivable while every rule was a literal
// path. Wildcards change both halves:
//
//   - A malformed pattern is DROPPED SILENTLY by Cloudflare. It saves fine,
//     shows fine in the portal, and does nothing in production. Validation
//     has to happen at write time or it effectively never happens.
//   - A pattern can shadow LIVE PAGES — `/blogg/*` hides every article under
//     it, because Pages evaluates `_redirects` before serving static files.
//     The existing hygiene rule ("a real page always beats a redirect") is
//     enforced per-URL for literals; for a pattern it has to be enforced by
//     matching, and the honest place to do that is when the author writes
//     the rule and can still narrow it.
//
// The deploy runner keeps its belt-and-braces drop for anything that slips
// through (a page published after the rule was created).

import { paths, validateRedirectPattern, pagesShadowedByRedirect, isRedirectPattern } from '@typeroll/shared';
import type { Page } from '@typeroll/shared';
import { vstore } from './version-store';
import { pageUrlFromDoc } from './page-paths';
import { isLivePageStatus } from './redirect-hygiene';

export type RedirectWriteCheck = { ok: true } | { ok: false; error: string };

/**
 * Doc id for a redirect. Patterns need distinct ids from the literal paths
 * they resemble: a naïve `[^a-zA-Z0-9._-] → _` mapping turns `/blogg/*` and
 * `/blogg/:slug` into the same id, so writing the second would silently
 * overwrite the first.
 */
export function redirectDocId(fromPath: string): string {
  return (
    fromPath
      .replace(/^\//, '')
      .replace(/\*/g, '__splat')
      .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '__p_$1')
      .replace(/[\/\\]/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120) || `r-${Date.now()}`
  );
}

/**
 * Validate a redirect before it is written. Returns a caller-facing error
 * string, never throws.
 */
export async function checkRedirectWrite(args: {
  orgId: string;
  siteId: string;
  versionId: string;
  from_path: string;
  to_path: string;
}): Promise<RedirectWriteCheck> {
  const syntax = validateRedirectPattern(args.from_path, args.to_path);
  if (!syntax.ok) {
    return { ok: false, error: `Invalid redirect: ${syntax.error}` };
  }
  if (!args.to_path.startsWith('/') && !/^https?:\/\//.test(args.to_path)) {
    return { ok: false, error: 'Invalid redirect: to_path must be a site-relative path ("/x") or an absolute http(s) URL' };
  }

  const pages = await vstore.pages(args.orgId, args.siteId, args.versionId);
  const liveUrls = pages
    .filter((p: Page) => isLivePageStatus(p.status))
    .map((p: Page) => pageUrlFromDoc(p));
  const shadowed = pagesShadowedByRedirect(args.from_path, args.to_path, liveUrls);
  if (shadowed.length) {
    const list = shadowed.slice(0, 8).join(', ') + (shadowed.length > 8 ? `, +${shadowed.length - 8} more` : '');
    return {
      ok: false,
      error:
        `This rule would hide ${shadowed.length} live page(s): ${list}. ` +
        'Cloudflare Pages applies redirects before serving files, so the page would become unreachable. ' +
        (isRedirectPattern(args.from_path)
          ? 'Narrow the pattern (a deeper prefix), or unpublish the page(s) if the redirect is what you want.'
          : 'Delete or unpublish the page first if the redirect is what you want.'),
    };
  }
  return { ok: true };
}
