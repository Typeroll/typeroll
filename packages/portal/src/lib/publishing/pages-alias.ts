/**
 * The hostname Cloudflare Pages serves a branch deployment on. Cloudflare
 * shortens the branch label: lowercase, characters other than a-z, 0-9 and '-'
 * become '-', at most 28 characters, no leading or trailing '-'. A long version
 * branch such as `version-seo-sharing-render-refresh-2026-11-04` is served on
 * `version-seo-sharing-render-r.<project>.pages.dev`, not on the full name.
 *
 * The alias Cloudflare returned for the deployment wins; the label rule is the
 * fallback when no deployment is at hand.
 */

export const PAGES_BRANCH_LABEL_LIMIT = 28;

export function pagesBranchLabel(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, PAGES_BRANCH_LABEL_LIMIT).replace(/^-+|-+$/g, '');
}

export function pagesBranchHost(project: string, branch: string, deployment?: { aliases?: unknown; short_id?: unknown } | null): string {
  if (branch === 'main') return `${project}.pages.dev`;
  const suffix = `.${project}.pages.dev`;
  const immutable = typeof deployment?.short_id === 'string' ? `${deployment.short_id}${suffix}` : null;
  for (const alias of Array.isArray(deployment?.aliases) ? deployment.aliases : []) {
    try {
      const host = new URL(String(alias)).hostname.toLowerCase();
      if (host.endsWith(suffix) && host !== immutable && /^[a-z0-9-]+$/.test(host.slice(0, -suffix.length))) return host;
    } catch { /* not a URL */ }
  }
  return `${pagesBranchLabel(branch)}${suffix}`;
}
