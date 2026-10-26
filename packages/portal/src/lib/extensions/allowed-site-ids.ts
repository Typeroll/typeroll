// A private Extension's `allowed_site_ids` list. Each entry is either a bare
// site id, which matches only a site of the developer organization, or
// `org/site`, which names a site of another organization (see
// privateExtensionSiteAllowed in ./registry). Entries are checked when the
// developer saves the list, so a malformed entry is refused instead of
// silently never matching.

import { ExtensionRegistryError } from './registry';

export const MAX_ALLOWED_SITE_IDS = 500;

/** One id segment: 1–128 characters, no separators, whitespace or control
 *  characters, and not a relative path name. Same rule as stored ids. */
function isIdSegment(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && value !== '.' && value !== '..' && !/[/\\\s\x00-\x1f\x7f]/.test(value);
}

export function isAllowedSiteEntry(entry: string): boolean {
  const separator = entry.indexOf('/');
  if (separator === -1) return isIdSegment(entry);
  return isIdSegment(entry.slice(0, separator)) && isIdSegment(entry.slice(separator + 1));
}

/**
 * Validate an `allowed_site_ids` request value. Returns undefined when the
 * field is absent (or null, which leaves the list unchanged as before), the
 * de-duplicated list otherwise, and throws a 400
 * ExtensionRegistryError for anything that is not a list of valid entries.
 */
export function parseAllowedSiteIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ExtensionRegistryError('allowed_site_ids must be an array of site ids');
  if (value.length > MAX_ALLOWED_SITE_IDS) {
    throw new ExtensionRegistryError(`allowed_site_ids accepts at most ${MAX_ALLOWED_SITE_IDS} entries`);
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isAllowedSiteEntry(entry)) {
      throw new ExtensionRegistryError(
        'Each allowed_site_ids entry must be a site id of the developer organization or "org/site" for a site of another organization',
      );
    }
    entries.push(entry);
  }
  return [...new Set(entries)];
}
