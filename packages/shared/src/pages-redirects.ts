import { expandRedirectsForTrailingSlashPolicy, isRedirectPattern } from './redirect-patterns.js';
import type { TrailingSlashPolicy } from './url-policy.js';

export interface PagesRedirect { from_path: string; to_path: string; status_code: number }

/** Validate emitted declarations, including generated slash and hostname aliases. */
export function validatePagesRedirects(text: string): { static: number; dynamic: number; bytes: number } {
  const counts = { static: 0, dynamic: 0, bytes: new TextEncoder().encode(text).length };
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if ([...line].length > 1000) throw new Error(`_redirects:${index + 1}: declaration exceeds Cloudflare Pages' 1,000-character limit. Shorten the source or destination URL.`);
    const source = line.split(/\s+/)[0];
    // Only the source determines whether a rule is dynamic; https: is not a placeholder.
    const dynamic = isRedirectPattern(source);
    counts[dynamic ? 'dynamic' : 'static']++;
  }
  if (counts.static > 2000 || counts.dynamic > 100) {
    throw new Error(`_redirects: ${counts.static} static and ${counts.dynamic} dynamic declarations exceed Cloudflare Pages' limits (2,000 static, 100 dynamic). Counts include generated slash aliases and hostname rules. Consolidate equivalent paths into safe patterns, or configure Cloudflare Bulk Redirects separately and verify coverage before removing replaced rules.`);
  }
  return counts;
}

/** Shared by the CMS preflight and the frozen static renderer. */
export function buildPagesRedirects(
  site: { domain?: string; domain_alias?: string },
  redirects: PagesRedirect[],
  policy: TrailingSlashPolicy = 'always',
): string {
  const lines = expandRedirectsForTrailingSlashPolicy(redirects, policy)
    .map(rule => `${rule.from_path} ${rule.to_path} ${rule.status_code}`);
  if (site.domain && site.domain_alias) {
    for (const hostname of [site.domain, site.domain_alias]) if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Invalid canonical hostname');
    lines.unshift(`https://${site.domain_alias}/* https://${site.domain}/:splat 301!`);
  }
  const text = lines.length ? lines.join('\n') + '\n' : '';
  validatePagesRedirects(text);
  return text;
}
