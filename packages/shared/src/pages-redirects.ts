import { expandRedirectsForTrailingSlashPolicy, isRedirectPattern } from './redirect-patterns.js';
import { isQueryRedirect } from './query-redirects.js';
import { checkPagesRedirects, countPagesRedirectRules, PAGES_REDIRECT_LIMITS } from './pages-redirect-limits.mjs';
import type { Redirect } from './types.js';
import type { TrailingSlashPolicy } from './url-policy.js';

export type PagesPathRedirect = Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>;
import { BULK_MARKER } from './pages-redirect-overflow.mjs';
export { pagesBulkRedirects } from './pages-redirect-overflow.mjs';

function redirectLines(redirects: Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[], settings: { trailing_slash?: TrailingSlashPolicy }) {
  // Query-string rules cannot be expressed in `_redirects`; the publication
  // embeds them in the matching HTML document instead.
  const pathRules = redirects.filter(rule => !isQueryRedirect(rule.from_path));
  return expandRedirectsForTrailingSlashPolicy(pathRules, settings.trailing_slash ?? 'always')
    .map(rule => `${rule.from_path} ${rule.to_path} ${rule.status_code}`);
}

export interface PagesRedirectCapacity { static: number; dynamic: number; limit_static: number; limit_dynamic: number; remaining_static: number; over_limit: boolean; overflow_static: number; bulk_required: boolean }
/**
 * How many Cloudflare Pages rules these redirects emit, including slash aliases,
 * against the per-site limits. Publication adds media replacement rules and a
 * host alias line on top, so treat a small remainder as already full.
 */
export function pagesRedirectCapacity(redirects: Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[], settings: { trailing_slash?: TrailingSlashPolicy } = {}): PagesRedirectCapacity {
  const counts = countPagesRedirectRules(redirectLines(redirects, settings).join('\n'));
  return { static: counts.static, dynamic: counts.dynamic, limit_static: PAGES_REDIRECT_LIMITS.static, limit_dynamic: PAGES_REDIRECT_LIMITS.dynamic,
    overflow_static: Math.max(0, counts.static - PAGES_REDIRECT_LIMITS.static), bulk_required: counts.static > PAGES_REDIRECT_LIMITS.static, remaining_static: PAGES_REDIRECT_LIMITS.static - counts.static, over_limit: counts.static > PAGES_REDIRECT_LIMITS.static || counts.dynamic > PAGES_REDIRECT_LIMITS.dynamic };
}

/** Same expansion and capacity check for dry runs and final static output. */
export function pagesRedirectsFile(
  redirects: Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[],
  settings: { trailing_slash?: TrailingSlashPolicy } = {},
  site: { domain?: string; domain_alias?: string } = {},
  options: { bulkOverflow?: boolean } = {},
): string {
  const lines = redirectLines(redirects, settings);
  if (site.domain && site.domain_alias) {
    for (const hostname of [site.domain, site.domain_alias]) if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Invalid canonical hostname');
    lines.unshift(`https://${site.domain_alias}/* https://${site.domain}/:splat 301!`);
  }
  // Comments travel through old static build engines in the existing, hashed
  // control-file receipt. Pages ignores them; only the coordinator can activate
  // the exact overflow on a verified hostname in the customer's account.
  const emitted: string[] = [];
  let fixed = 0;
  for (const line of lines) {
    checkPagesRedirects(line);
    const [from_path, to_path, status] = line.split(/\s+/);
    if (!isRedirectPattern(from_path) && ++fixed > PAGES_REDIRECT_LIMITS.static && options.bulkOverflow) {
      emitted.push(BULK_MARKER + JSON.stringify({ from_path, to_path, status_code: Number(status) }));
    } else emitted.push(line);
  }
  const text = emitted.length ? emitted.join('\n') + '\n' : '';
  checkPagesRedirects(text);
  return text;
}
