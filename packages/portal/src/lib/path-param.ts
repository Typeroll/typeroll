/**
 * A route parameter as the caller wrote it, not as the router delivered it.
 *
 * Astro hands `params` through without percent-decoding, so an identifier
 * containing a slash arrives as `core%2Fembed` and compares equal to nothing.
 * On 2026-09-22 that made every `core/*` block type unreachable through
 * `block-types/{typeId}/usage`, which answered 200 with an empty list rather
 * than an error — it reported "not used" to a question it could not ask.
 *
 * The same undecoded value reached the deletion guard beside it, so
 * `CORE_BLOCK_TYPES.some(b => b.id === typeId)` never matched and the 403 never
 * fired. Core types survived only because the subsequent lookup missed too.
 * That is why decoding belongs at the top of a handler and not at the lookup:
 * decode where the failure is visible and the guard still compares an encoded
 * string, and a core block type becomes deletable for the first time.
 *
 * Returns null for a malformed sequence rather than throwing, so `%` alone is
 * a 400 from the caller's own validation instead of a 500.
 */
export function pathParam(value: string | undefined): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
