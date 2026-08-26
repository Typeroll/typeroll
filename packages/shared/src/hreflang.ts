// hreflang alternates for cross-domain language clusters.
//
// A Typeroll Site owns exactly one domain (plus its apex/www sibling), so a
// family of language sites — `example.se`, `example.de`, `example.co.uk` —
// is a family of *sites*. Nothing in the data model can derive which page on
// site B corresponds to a page on site A, so the mapping is declared per
// page in `Page.alternates` and rendered into <head>.
//
// Two rules the renderer depends on:
//
//  1. **The cluster must be reciprocal and self-inclusive.** Google ignores
//     a cluster whose members don't list each other, and every member must
//     list itself. Callers only declare the OTHER variants; `resolveAlternates`
//     injects the self-reference so a page can't accidentally omit it.
//  2. **Malformed entries are dropped, never emitted.** The values land in
//     an attribute in <head>; a bad tag is an SEO liability and a bad href
//     is an injection surface. Validation is allowlist-shaped, not
//     escape-shaped.

/** One `<link rel="alternate" hreflang="…" href="…">` target. */
export interface HreflangAlternate {
  /** BCP-47 language tag (`sv`, `en-GB`, `zh-Hant-TW`) or the literal `x-default`. */
  hreflang: string;
  /** Absolute https:// (or http://) URL of the equivalent page. */
  href: string;
}

/**
 * BCP-47 subset we accept: 2–3 letter primary language, optional script
 * (4 letters), optional region (2 letters or 3 digits). Deliberately
 * narrower than the full grammar — extensions and private-use subtags have
 * no meaning to search engines here, and a tight pattern is what keeps the
 * attribute safe without escaping.
 */
const TAG_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/** True when `tag` is a usable hreflang value. `x-default` is case-insensitive. */
export function isValidHreflangTag(tag: string): boolean {
  if (typeof tag !== 'string') return false;
  const t = tag.trim();
  if (!t) return false;
  if (t.toLowerCase() === 'x-default') return true;
  // Normalize casing before matching so `en-gb` (the common shape agents
  // and humans write) validates; canonicalization happens in normalizeTag.
  return TAG_RE.test(canonicalTag(t));
}

/**
 * Canonical casing per BCP-47: language lowercase, script Title-case,
 * region UPPERCASE. `en-gb` → `en-GB`, `zh-hant-tw` → `zh-Hant-TW`.
 */
export function canonicalTag(tag: string): string {
  const parts = tag.trim().split('-');
  return parts
    .map((p, i) => {
      if (i === 0) return p.toLowerCase();
      if (p.length === 4) return p[0].toUpperCase() + p.slice(1).toLowerCase();
      if (p.length === 2) return p.toUpperCase();
      return p.toLowerCase();
    })
    .join('-');
}

/** True when `href` is an absolute http(s) URL. Rejects protocol-relative,
 *  `javascript:`, `data:` and relative paths — an alternate always points at
 *  another origin, so requiring absolute costs nothing. */
export function isValidAlternateHref(href: string): boolean {
  if (typeof href !== 'string' || !href.trim()) return false;
  try {
    const u = new URL(href.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export interface ValidateAlternatesResult {
  /** Entries that passed, canonicalized and de-duplicated by tag. */
  valid: HreflangAlternate[];
  /** Human-readable reasons, one per dropped entry. Surfaced by the API so
   *  a write that silently lost half its cluster is visible to the caller. */
  rejected: string[];
}

/**
 * Validate a caller-supplied alternates array. Used by every write surface
 * (v1 REST, MCP) so a bad cluster is reported at write time rather than
 * discovered as missing markup after a deploy.
 */
export function validateAlternates(input: unknown): ValidateAlternatesResult {
  const valid: HreflangAlternate[] = [];
  const rejected: string[] = [];
  if (!Array.isArray(input)) {
    return { valid, rejected: input == null ? [] : ['alternates must be an array'] };
  }
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      rejected.push(`not an object: ${JSON.stringify(raw)}`);
      continue;
    }
    const entry = raw as Partial<HreflangAlternate>;
    const tag = typeof entry.hreflang === 'string' ? entry.hreflang.trim() : '';
    const href = typeof entry.href === 'string' ? entry.href.trim() : '';
    if (!isValidHreflangTag(tag)) {
      rejected.push(`invalid hreflang tag: ${JSON.stringify(entry.hreflang ?? null)}`);
      continue;
    }
    if (!isValidAlternateHref(href)) {
      rejected.push(`invalid href for ${tag}: ${JSON.stringify(entry.href ?? null)}`);
      continue;
    }
    const canonical = tag.toLowerCase() === 'x-default' ? 'x-default' : canonicalTag(tag);
    if (seen.has(canonical)) {
      rejected.push(`duplicate hreflang tag: ${canonical}`);
      continue;
    }
    seen.add(canonical);
    valid.push({ hreflang: canonical, href });
  }
  return { valid, rejected };
}

/**
 * Build the final list the renderer emits: the page's declared alternates
 * plus a self-reference under the page's own language.
 *
 * The self-entry goes FIRST (conventional ordering, and it's the one a
 * human debugging the cluster looks for). A declared entry whose tag
 * matches the page's own language wins over the injected self-reference —
 * that's the escape hatch for a page whose canonical URL differs from the
 * one the cluster should point at.
 *
 * Returns an empty array when there are no declared alternates: a lone
 * self-referencing hreflang is meaningless markup, and emitting it on
 * every page of every single-language site would be pure noise.
 */
export function resolveAlternates(
  declared: HreflangAlternate[] | undefined | null,
  selfUrl: string,
  selfLanguage: string,
): HreflangAlternate[] {
  const { valid } = validateAlternates(declared ?? []);
  if (valid.length === 0) return [];
  const selfTag = isValidHreflangTag(selfLanguage) ? canonicalTag(selfLanguage) : '';
  if (!selfTag || !isValidAlternateHref(selfUrl)) return valid;
  if (valid.some((a) => a.hreflang === selfTag)) return valid;
  return [{ hreflang: selfTag, href: selfUrl }, ...valid];
}
