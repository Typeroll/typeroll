/** Cloudflare Pages limits apply to the emitted file, including generated aliases.
 * https://developers.cloudflare.com/pages/configuration/redirects/#limits
 * No network, Node APIs or CMS dependencies: also vendored into build supervisors.
 */
export const PAGES_REDIRECT_LIMITS = Object.freeze({ static: 2000, dynamic: 100, line: 1000 });
// UTF-8 can use four bytes per character. Bound transport independently of the
// provider's rule counts; keep a little space for comments and line endings.
export const MAX_PAGES_REDIRECT_BYTES = 10 * 1024 * 1024;
export function checkPagesRedirects(text) {
  if (new TextEncoder().encode(text).length > MAX_PAGES_REDIRECT_BYTES) throw new Error('Redirect file exceeds the 10 MiB transport limit.');
  let fixed = 0, dynamic = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if ([...raw].length > PAGES_REDIRECT_LIMITS.line) throw new Error(`_redirects line ${index + 1} exceeds Cloudflare Pages’ 1000-character limit.`);
    const from = line.split(/\s+/)[0];
    if (from.includes('*') || /(^|[/.]):[A-Za-z_][A-Za-z0-9_]*/.test(from)) dynamic++;
    else fixed++;
  }
  if (fixed > PAGES_REDIRECT_LIMITS.static || dynamic > PAGES_REDIRECT_LIMITS.dynamic) {
    throw new Error(`Cloudflare Pages supports 2000 static and 100 dynamic redirects per site. This publication emits ${fixed} static and ${dynamic} dynamic rules, including generated slash aliases and host redirects. Reduce or consolidate rules before publishing; do not delete required migration redirects without replacing their coverage.`);
  }
  return { static: fixed, dynamic, total: fixed + dynamic };
}
