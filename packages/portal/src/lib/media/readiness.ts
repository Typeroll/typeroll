import type { Media } from '@typeroll/shared';
import type { ImportingMedia } from './import-retry';

export type MediaReadiness = { state: 'ready' | 'pending' | 'failed'; selectable: boolean; message: string | null };

/** A reserved media identity is not a file. Keep this check usable in the browser. */
export function mediaReadiness(media: Media): MediaReadiness {
  const item = media as ImportingMedia;
  // A verified copy wins over failure flags left by an earlier migration pass.
  if (item.storage?.state === 'ready') return { state: 'ready', selectable: true, message: null };
  if (item.import_rejected || item.migration_failed) return { state: 'failed', selectable: false,
    message: 'This file could not be imported or copied. Check its source and retry the import, or replace the file.' };
  if (item.import_pending || item.storage) return { state: 'pending', selectable: false,
    message: item.source_url ? 'The source file has not been copied and verified yet. It cannot be selected.' : 'The upload has not been verified yet. It cannot be selected.' };
  if (!item.r2_key && (item.source_url || privateMediaReferences(item.cdn_url).length)) return { state: 'failed', selectable: false,
    message: 'No stored file is available for this media record. Import or upload a replacement file.' };
  // Legacy files predate storage receipts; their existing selection behavior stays intact.
  return { state: 'ready', selectable: true, message: null };
}

/** Stable private media identities, never signed object addresses. */
export function privateMediaReferences(value: unknown): Array<{ siteId: string; mediaId: string }> {
  const found = new Map<string, { siteId: string; mediaId: string }>();
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const match of (serialized ?? '').matchAll(/\/api\/sites\/([a-zA-Z0-9_%.-]+)\/media\/([a-zA-Z0-9_%.-]+)\/content(?=[?#\s"'<>),\]\\]|$)/g)) {
    try {
      const siteId = decodeURIComponent(match[1]), mediaId = decodeURIComponent(match[2]);
      if (siteId.includes('/') || mediaId.includes('/')) continue;
      found.set(`${siteId}/${mediaId}`, { siteId, mediaId });
    } catch { /* Invalid encoded paths cannot resolve to a stored media identity. */ }
  }
  return [...found.values()];
}
