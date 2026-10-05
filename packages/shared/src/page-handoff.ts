// Page handoff: values a visitor typed into a native `core/navigation_form`
// banner, carried in this browser tab to the page the banner navigates to.
//
// The storage key and packet shape are private to the platform. The writer
// (the navigation form) and every reader (a receiving navigation form and the
// Extension host's `context.handoff`) are generated from this module by the
// same Core build, so the format can change in a release without breaking an
// installed Extension, which only ever sees the normalized result.
//
// Values never enter a URL, a referrer, a request or an analytics event. On a
// published site they live in `sessionStorage`; in an opaque preview, which has
// no Web Storage, the preview shell keeps them for the tab instead.

/** Private storage prefix. Not part of any public contract. */
export const PAGE_HANDOFF_STORAGE_PREFIX = 'typeroll:page-defaults:v1:';

/** Handoff keys are the navigation form's "Defaults key". */
export const PAGE_HANDOFF_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Structured address parts carried beside a field's display string. */
export const PAGE_HANDOFF_PART_NAMES = [
  'street',
  'street_number',
  'postal_code',
  'locality',
  'country',
  'formatted',
] as const;

/**
 * Validate one stored packet for the page at `pathname` and return its field
 * values, or null when it is absent, malformed, expired, addressed to another
 * page or claims an implausible lifetime.
 *
 * Serialized with `Function#toString` into the browser runtimes, so it must
 * stay self-contained: no module references, no nested named functions.
 */
export function parsePageHandoffPacket(
  raw: unknown,
  pathname: string,
  now: number,
): Record<string, string> | null {
  if (typeof raw !== 'string' || !raw || raw.length > 20000) return null;
  let packet: unknown;
  try {
    packet = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
  const record = packet as { version?: unknown; target?: unknown; expires?: unknown; values?: unknown };
  if (
    record.version !== 1 ||
    record.target !== pathname ||
    typeof record.expires !== 'number' ||
    !Number.isFinite(record.expires) ||
    record.expires < now ||
    record.expires > now + 900000
  )
    return null;
  const source = record.values;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const values: Record<string, string> = {};
  const names = Object.keys(source).slice(0, 256);
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    const value = (source as Record<string, unknown>)[name];
    if (
      /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) &&
      name.toLowerCase() !== 'constructor' &&
      name.toLowerCase() !== 'prototype' &&
      !/password|token|secret|authorization/i.test(name) &&
      typeof value === 'string' &&
      value.length <= 512
    )
      values[name] = value;
  }
  return values;
}

/**
 * Group flat `<field>_<part>` values under the field that produced them, for
 * example `address_from_postal_code` under `address_from.postal_code`. A part
 * is only grouped when its field is present too, which is how the navigation
 * form writes them. Self-contained for the same reason as the parser.
 */
export function groupPageHandoffParts(
  values: Record<string, string>,
): Record<string, Record<string, string>> {
  const parts = ['street', 'street_number', 'postal_code', 'locality', 'country', 'formatted'];
  const grouped: Record<string, Record<string, string>> = {};
  const names = Object.keys(values);
  for (let index = 0; index < names.length; index++) {
    const field = names[index]!;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]!;
      const name = field + '_' + part;
      if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
      if (!grouped[field]) grouped[field] = {};
      grouped[field]![part] = values[name]!;
    }
  }
  return grouped;
}
