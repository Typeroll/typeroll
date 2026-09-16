import { createHash } from 'node:crypto';

/** Changing bytes, destinations or aliases requires a new immutable completion receipt. */
export function mediaReceiptKey(manifest, entry) {
  const scope = [manifest.account_id, manifest.original_bucket, manifest.public_bucket, manifest.site_prefix,
    entry.source_key, entry.sha256, entry.size_bytes ?? null, entry.mime_type, entry.public_key, entry.public_path,
    (entry.aliases ?? []).map(alias => JSON.stringify([alias.key, alias.url])).sort()];
  return entry.public_key + '.prepared-v1.' + createHash('sha256').update(JSON.stringify(scope)).digest('hex') + '.json';
}
