import { expandRedirectsForTrailingSlashPolicy } from './redirect-patterns.js';
import { isQueryRedirect } from './query-redirects.js';
import { checkPagesRedirects, countPagesRedirectRules, PAGES_REDIRECT_LIMITS } from './pages-redirect-limits.mjs';
import type { Redirect } from './types.js';
import type { TrailingSlashPolicy } from './url-policy.js';

function redirectLines(redirects: Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[], settings: { trailing_slash?: TrailingSlashPolicy }) {
  // Query-string rules cannot be expressed in `_redirects`; the publication
  // embeds them in the matching HTML document instead.
  const pathRules = redirects.filter(rule => !isQueryRedirect(rule.from_path));
  return expandRedirectsForTrailingSlashPolicy(pathRules, settings.trailing_slash ?? 'always')
    .map(rule => `${rule.from_path} ${rule.to_path} ${rule.status_code}`);
}

export interface PagesRedirectCapacity { static: number; dynamic: number; limit_static: number; limit_dynamic: number; remaining_static: number; over_limit: boolean }
/**
 * How many Cloudflare Pages rules these redirects emit, including slash aliases,
 * against the per-site limits. Publication adds media replacement rules and a
 * host alias line on top, so treat a small remainder as already full.
 */
export function pagesRedirectCapacity(redirects: Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[], settings: { trailing_slash?: TrailingSlashPolicy } = {}): PagesRedirectCapacity {
  const counts = countPagesRedirectRules(redirectLines(redirects, settings).join('\n'));
  return { static: counts.static, dynamic: counts.dynamic, limit_static: PAGES_REDIRECT_LIMITS.static, limit_dynamic: PAGES_REDIRECT_LIMITS.dynamic,
    remaining_static: PAGES_REDIRECT_LIMITS.static - counts.static, over_limit: counts.static > PAGES_REDIRECT_LIMITS.static || counts.dynamic > PAGES_REDIRECT_LIMITS.dynamic };
}

/** Same expansion and capacity check for dry runs and final static output. */
export function pagesRedirectsFile(
  redirects: Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[],
  settings: { trailing_slash?: TrailingSlashPolicy } = {},
  site: { domain?: string; domain_alias?: string } = {},
): string {
  const lines = redirectLines(redirects, settings);
  if (site.domain && site.domain_alias) {
    for (const hostname of [site.domain, site.domain_alias]) if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Invalid canonical hostname');
    lines.unshift(`https://${site.domain_alias}/* https://${site.domain}/:splat 301!`);
  }
  const text = lines.length ? lines.join('\n') + '\n' : '';
  checkPagesRedirects(text);
  return text;
}
