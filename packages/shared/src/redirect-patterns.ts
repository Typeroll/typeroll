// Wildcard redirect patterns.
//
// A WordPress migration produces whole FAMILIES of dead URLs, not individual
// ones: `/category/*`, `/tag/*`, `/author/*`, `/2019/*`, `/?p=` — hundreds of
// paths that all deserve the same destination. Writing them out one by one is
// both tedious and incomplete (the inventory only knows the URLs it found;
// the old site had more).
//
// Cloudflare Pages' `_redirects` format already supports splats and named
// placeholders. This module is the platform's contract on top of it, so that
// the SAME semantics apply in three places that must not drift:
//
//   1. write time — validation, so a malformed pattern is refused when it's
//      cheap to fix rather than discovered as a broken deploy;
//   2. coverage analysis — an inventory URL covered by `/category/*` must
//      report as `redirected`, or the migration's work list never empties;
//   3. deploy — the emitted file's ORDER decides which rule wins, because
//      Cloudflare stops at the first match.
//
// Supported syntax (deliberately a subset of what CF accepts):
//
//   /old/*              → trailing splat; `:splat` in the target carries the
//                         captured remainder.
//   /blog/:slug         → a named placeholder matching exactly ONE segment;
//                         `:slug` in the target substitutes it.
//   /shop/:cat/:id      → several placeholders.
//
// NOT supported: a splat anywhere but the end (CF ignores it), regexes, or
// query strings (`_redirects` matches on path only — a `/?p=123` style rule
// cannot be expressed and must be handled as an exact path).

/** True when `from_path` is a pattern rather than a literal path. */
export function isRedirectPattern(fromPath: string): boolean {
  return fromPath.includes('*') || /(^|\/):[A-Za-z_][A-Za-z0-9_]*(\/|$)/.test(fromPath);
}

const PLACEHOLDER_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

export interface RedirectPatternValidation {
  ok: boolean;
  error?: string;
  /** Placeholder names declared in from_path, in order. */
  params?: string[];
  /** Whether from_path ends in a splat. */
  hasSplat?: boolean;
}

/**
 * Validate a from/to pair. The rules exist because CF fails SILENTLY on a
 * malformed line — it drops it — so an unvalidated pattern reads as "saved"
 * in the portal and does nothing in production.
 */
export function validateRedirectPattern(
  fromPath: string,
  toPath: string,
): RedirectPatternValidation {
  if (!fromPath.startsWith('/')) {
    return { ok: false, error: 'from_path must start with "/"' };
  }
  if (/\s/.test(fromPath) || /\s/.test(toPath)) {
    return { ok: false, error: 'paths cannot contain whitespace — _redirects is a space-delimited format' };
  }
  if (fromPath.includes('?') || fromPath.includes('#')) {
    return {
      ok: false,
      error: 'from_path matches the path only — query strings and fragments cannot be matched. ' +
        'A WordPress "/?p=123" URL needs handling at the source, not here.',
    };
  }

  const starCount = (fromPath.match(/\*/g) ?? []).length;
  let hasSplat = false;
  if (starCount > 0) {
    if (starCount > 1) {
      return { ok: false, error: 'only one "*" is allowed, at the end of from_path (e.g. "/category/*")' };
    }
    if (!fromPath.endsWith('*')) {
      return {
        ok: false,
        error: '"*" is only supported at the END of from_path (e.g. "/category/*"). ' +
          'Cloudflare ignores a mid-path splat, which would make the rule silently dead.',
      };
    }
    hasSplat = true;
  }

  const params: string[] = [];
  for (const segment of fromPath.split('/')) {
    if (!segment.startsWith(':')) continue;
    const m = PLACEHOLDER_RE.exec(segment);
    if (!m) {
      return {
        ok: false,
        error: `invalid placeholder "${segment}" — use ":name" covering a whole segment (letters, digits, underscore)`,
      };
    }
    if (params.includes(m[1])) {
      return { ok: false, error: `duplicate placeholder ":${m[1]}" in from_path` };
    }
    params.push(m[1]);
  }

  // A target may only reference captures the source actually declares —
  // otherwise CF emits the literal ":slug" into the Location header and the
  // visitor lands on a 404 with a colon in the URL.
  for (const token of toPath.match(/:([A-Za-z_][A-Za-z0-9_]*)/g) ?? []) {
    const name = token.slice(1);
    if (name === 'splat') {
      if (!hasSplat) {
        return { ok: false, error: 'to_path uses ":splat" but from_path has no "*"' };
      }
      continue;
    }
    if (!params.includes(name)) {
      return { ok: false, error: `to_path uses ":${name}" but from_path does not declare it` };
    }
  }

  if (toPath.includes('*')) {
    return { ok: false, error: 'to_path cannot contain "*" — use ":splat" to insert the captured remainder' };
  }

  return { ok: true, params, hasSplat };
}

/**
 * Match `path` against a rule. Returns the RESOLVED target (with `:splat` and
 * `:name` substituted) or null when the rule doesn't apply.
 *
 * Matching is exact for literal rules and segment-wise for patterns. A
 * trailing splat matches the empty remainder too: `/category/*` covers
 * `/category` as well as `/category/mat/recept`, which is what an author
 * means by "everything under here, including the index".
 */
export function matchRedirect(
  fromPath: string,
  toPath: string,
  path: string,
): string | null {
  if (!isRedirectPattern(fromPath)) {
    return normalize(fromPath) === normalize(path) ? toPath : null;
  }

  const hasSplat = fromPath.endsWith('*');
  const fromBody = hasSplat ? fromPath.slice(0, -1) : fromPath;
  const fromSegments = trimSlashes(fromBody).split('/').filter((s) => s !== '');
  const pathSegments = trimSlashes(normalize(path)).split('/').filter((s) => s !== '');

  if (hasSplat ? pathSegments.length < fromSegments.length : pathSegments.length !== fromSegments.length) {
    return null;
  }

  const captures: Record<string, string> = {};
  for (let i = 0; i < fromSegments.length; i++) {
    const expected = fromSegments[i];
    const actual = pathSegments[i];
    const placeholder = PLACEHOLDER_RE.exec(expected);
    if (placeholder) {
      if (!actual) return null;
      captures[placeholder[1]] = actual;
      continue;
    }
    if (expected !== actual) return null;
  }

  if (hasSplat) {
    captures.splat = pathSegments.slice(fromSegments.length).join('/');
  }

  return toPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) =>
    name in captures ? captures[name] : whole,
  );
}

/**
 * Specificity score — higher wins. Used to ORDER the emitted file, because
 * Cloudflare stops at the first matching line: `/blogg/recept/*` must be
 * emitted before `/blogg/*`, or the broader rule swallows the narrower one
 * and the author's more specific intent never fires.
 *
 * Literal segments outrank placeholders, and any literal rule outranks any
 * pattern.
 */
export function redirectSpecificity(fromPath: string): number {
  if (!isRedirectPattern(fromPath)) return 1_000_000 + fromPath.length;
  const hasSplat = fromPath.endsWith('*');
  const segments = trimSlashes(hasSplat ? fromPath.slice(0, -1) : fromPath)
    .split('/')
    .filter((s) => s !== '');
  let score = 0;
  for (const s of segments) score += PLACEHOLDER_RE.test(s) ? 1 : 10;
  // A placeholder rule is narrower than a splat rule with the same prefix:
  // it matches exactly one segment.
  if (!hasSplat) score += 5;
  return score;
}

/**
 * Order rules the way they must be emitted: literals first (most specific
 * literal first for stability), then patterns by descending specificity.
 * Stable within a score so the file doesn't churn between deploys.
 */
export function sortRedirectsForEmit<T extends { from_path: string }>(rules: T[]): T[] {
  return rules
    .map((rule, index) => ({ rule, index, score: redirectSpecificity(rule.from_path) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((e) => e.rule);
}

/**
 * Live page URLs a rule would capture. Cloudflare Pages evaluates
 * `_redirects` BEFORE serving static files, so a rule matching a real page's
 * URL hides that page completely — the failure mode redirect-hygiene exists
 * to prevent. A pattern can do it to many pages at once, which is why this
 * takes the whole set rather than answering yes/no for one path.
 */
export function pagesShadowedByRedirect(
  fromPath: string,
  toPath: string,
  livePageUrls: Iterable<string>,
): string[] {
  const hit: string[] = [];
  for (const url of livePageUrls) {
    const resolved = matchRedirect(fromPath, toPath, url);
    if (resolved === null) continue;
    // A rule that resolves to the very URL it matched is a no-op, not a
    // shadow — it can't hide anything it would only redirect to itself.
    if (normalize(resolved) === normalize(url)) continue;
    hit.push(url);
  }
  return hit;
}

function normalize(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

function trimSlashes(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}
