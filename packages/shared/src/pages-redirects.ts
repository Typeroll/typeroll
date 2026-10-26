import { expandRedirectsForTrailingSlashPolicy } from './redirect-patterns.js';
import { checkPagesRedirects } from './pages-redirect-limits.mjs';
import type { Redirect } from './types.js';
import type { TrailingSlashPolicy } from './url-policy.js';

/** Same expansion and capacity check for dry runs and final static output. */
export function pagesRedirectsFile(
  redirects: Pick<Redirect, 'from_path' | 'to_path' | 'status_code'>[],
  settings: { trailing_slash?: TrailingSlashPolicy } = {},
  site: { domain?: string; domain_alias?: string } = {},
): string {
  const lines = expandRedirectsForTrailingSlashPolicy(redirects, settings.trailing_slash ?? 'always')
    .map(rule => `${rule.from_path} ${rule.to_path} ${rule.status_code}`);
  if (site.domain && site.domain_alias) {
    for (const hostname of [site.domain, site.domain_alias]) if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Invalid canonical hostname');
    lines.unshift(`https://${site.domain_alias}/* https://${site.domain}/:splat 301!`);
  }
  const text = lines.length ? lines.join('\n') + '\n' : '';
  checkPagesRedirects(text);
  return text;
}
