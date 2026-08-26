// Write-time validation for Page.alternates (hreflang cluster).
//
// The renderer already drops malformed entries, so this isn't a safety
// gate — it's a feedback gate. An agent wiring ten language sites together
// writes 10 × N alternates; discovering that half of them were silently
// ignored requires deploying and reading the HTML. A 400 naming the bad
// entry at write time is the difference between a five-minute fix and an
// SEO bug nobody notices for a month.

import { validateAlternates, type HreflangAlternate } from '@typeroll/shared';

export type AlternatesCheck =
  | { ok: true; present: false }
  | { ok: true; present: true; value: HreflangAlternate[] | null }
  | { ok: false; error: string };

/**
 * Validate `body.alternates` if the caller sent it. Returns the
 * canonicalized array (tags normalized to BCP-47 casing, duplicates
 * removed) so the stored doc is uniform regardless of how it was written.
 * `null` clears the field.
 */
export function checkAlternates(body: { alternates?: unknown }): AlternatesCheck {
  if (!('alternates' in body) || body.alternates === undefined) return { ok: true, present: false };
  if (body.alternates === null) return { ok: true, present: true, value: null };
  if (!Array.isArray(body.alternates)) {
    return { ok: false, error: 'alternates must be an array of { hreflang, href } (or null to clear)' };
  }
  const { valid, rejected } = validateAlternates(body.alternates);
  if (rejected.length) {
    return {
      ok: false,
      error: `Invalid hreflang alternates — nothing was written. ${rejected.join('; ')}`,
    };
  }
  return { ok: true, present: true, value: valid };
}
