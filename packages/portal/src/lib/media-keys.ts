// Media R2 key construction — anonymous, portable public path.
//
// Media URLs are PUBLIC (served from cdn.typeroll.com). The key must not leak
// the org/agency (the slug is derived from their name) AND must not break when
// a site moves between orgs. So the key is namespaced by a random per-SITE id
// that travels with the site — not by org or by any name-derived slug.
//
// Key shape: `media/{site.media_id}/{filename}`
//   - `media/` is the only folder; the old `orgs`/`sites`/`images` segments
//     carried no meaning in a CDN path.
//   - `media_id` is a random 10-char [0-9a-z] string, unique per site,
//     generated at site creation (lazily backfilled here for older sites).
//
// NEW UPLOADS ONLY: existing media keep their old keys (R2 keys are immutable
// and content hardcodes the full CDN URL). No migration — this only changes
// where future objects land. Variant keys derive from the base key, so
// AVIF/WebP follow the new scheme automatically.

import { randomInt } from 'node:crypto';
import { paths, type Site } from '@typeroll/shared';
import { getStore, type ReadWriteStore } from './datastore';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random 10-char id from [0-9a-z] for the public media key prefix. */
export function randomMediaId(len = 10): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Resolve the anonymous `media/{site.media_id}` prefix for an upload.
 * Generates + persists a `media_id` on the site doc the first time (lazy
 * backfill for sites created before the field existed). Callers append
 * `/{filename}` to the returned prefix. `orgId` is only used to locate the
 * site doc in Firestore — it never appears in the returned public key.
 */
export async function siteMediaPrefix(
  orgId: string,
  siteId: string,
  store: ReadWriteStore = getStore(),
): Promise<string> {
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  let mediaId = site?.media_id;
  if (!mediaId) {
    mediaId = randomMediaId();
    // Backfill once. Merge-update so we don't clobber sibling fields. Only
    // persist when the site doc exists (uploads always run under a real,
    // authenticated site).
    if (site) await store.updateDoc(paths.site(orgId, siteId), { media_id: mediaId });
  }
  return `media/${mediaId}`;
}
