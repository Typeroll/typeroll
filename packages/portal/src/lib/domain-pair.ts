// Hostname pair classifier + canonical-picker.
//
// Cloudflare Pages routes by Host header. A project that's only registered
// for `www.example.com` will return 522 for `example.com` even though the
// DNS resolves to the same IP pool. The customer experience is brutal:
// the domain "works" everywhere except for the one variant the user
// actually typed in their browser.
//
// Fix: every time a user adds a hostname, the platform registers BOTH the
// apex and the www variant on the Pages project, picks one as canonical,
// and emits a cross-hostname 301 from the other. The user never has to
// think about it.
//
// This module is the pure-function half — hostname parsing + sibling
// derivation + canonical selection. Cloudflare API calls + datastore
// writes live in site-domain.ts.
//
// What we DON'T do here: full-ICANN-aware PSL parsing. Generic public
// suffixes (.co.uk, .com.au, .se.it, …) need the Public Suffix List to
// know where the "registrable" boundary is. We classify a hostname as
// an apex only when it has exactly two dot-separated labels — anything
// else is treated as a subdomain (no sibling derived) so we don't
// accidentally try to register "co.uk" or "autopilot.example.co.uk"'s
// "example.co.uk" sibling. Users with PSL-style domains get standard
// single-domain behaviour and can add both variants manually.

export type HostnameKind = 'apex' | 'www' | 'subdomain';

export interface HostnameClassification {
  kind: HostnameKind;
  /** Normalised input — lowercased, protocol/path stripped. */
  hostname: string;
  /** The apex form (`example.com`) when derivable, else null. */
  apex: string | null;
  /** The www form (`www.example.com`) when derivable, else null. */
  www: string | null;
}

/** Strip protocol, path, port; lowercase. */
export function normalizeHostname(input: string): string {
  let h = (input ?? '').trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  // Strip trailing dot (FQDN form some users paste).
  h = h.replace(/\.$/, '');
  return h;
}

/** Conservative hostname validator. ASCII labels, dot-separated, no IDN
 *  homograph handling (the customer enters their own domain). */
export function isValidHostname(h: string): boolean {
  if (h.length < 4 || h.length > 253) return false;
  if (!/\./.test(h)) return false;
  return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h);
}

/**
 * Classify a hostname. Returns the kind + the apex/www variants when
 * derivable.
 *
 * Rules:
 *   - 2 labels (`example.com`)           → apex.  www = `www.example.com`.
 *   - 3 labels starting with "www"
 *     AND middle label is a real apex   → www.   apex = drop leading "www".
 *   - 3+ labels, anything else           → subdomain. No sibling derived.
 *
 * "Real apex" check is just "2 labels after dropping www" — keeps us off
 * the PSL grenade. Customers on .co.uk get standard single-domain flow.
 */
export function classifyHostname(input: string): HostnameClassification {
  const hostname = normalizeHostname(input);
  if (!isValidHostname(hostname)) {
    return { kind: 'subdomain', hostname, apex: null, www: null };
  }
  const labels = hostname.split('.');
  if (labels.length === 2) {
    return {
      kind: 'apex',
      hostname,
      apex: hostname,
      www: `www.${hostname}`,
    };
  }
  if (labels.length === 3 && labels[0] === 'www') {
    const apex = labels.slice(1).join('.');
    return {
      kind: 'www',
      hostname,
      apex,
      www: hostname,
    };
  }
  // Subdomain (app.foo.com, shop.foo.com, …) — no sibling, register as-is.
  return { kind: 'subdomain', hostname, apex: null, www: null };
}

/**
 * Returns the sister hostname for an apex/www input, or null when the
 * input is a subdomain (no sibling to register).
 *
 *   siblingOf('example.com')      → 'www.example.com'
 *   siblingOf('www.example.com')  → 'example.com'
 *   siblingOf('app.example.com')  → null
 */
export function siblingOf(hostname: string): string | null {
  const c = classifyHostname(hostname);
  if (c.kind === 'apex') return c.www;
  if (c.kind === 'www') return c.apex;
  return null;
}

export interface CanonicalPick {
  canonical: string;
  /** The variant that should 301 → canonical. Null when there's no pair
   *  (input was a subdomain that we register as-is). */
  alias: string | null;
  /** Both hostnames that should be registered on the Pages project. The
   *  canonical is always first; for subdomain inputs this has length 1. */
  registrations: string[];
}

/**
 * Decide which variant is canonical for an apex/www pair.
 *
 *   pickCanonical('example.com', 'apex')   → { canonical: 'example.com', alias: 'www.example.com', registrations: [...] }
 *   pickCanonical('www.example.com', 'apex') → same — input doesn't drive canonical, preference does
 *   pickCanonical('example.com', 'www')    → { canonical: 'www.example.com', alias: 'example.com', registrations: [...] }
 *   pickCanonical('app.example.com', 'apex') → { canonical: 'app.example.com', alias: null, registrations: ['app.example.com'] }
 *
 * The customer's input is authoritative for the *zone* — we never
 * cross domains. But within the zone, the canonical follows the
 * platform-wide preference (apex by default, configurable per site).
 */
export function pickCanonical(input: string, prefer: 'apex' | 'www' = 'apex'): CanonicalPick {
  const c = classifyHostname(input);
  if (c.kind === 'subdomain' || !c.apex || !c.www) {
    return { canonical: c.hostname, alias: null, registrations: [c.hostname] };
  }
  const canonical = prefer === 'apex' ? c.apex : c.www;
  const alias = prefer === 'apex' ? c.www : c.apex;
  return { canonical, alias, registrations: [canonical, alias] };
}
