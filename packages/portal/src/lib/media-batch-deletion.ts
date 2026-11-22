import { deleteMediaItem } from './media-deletion';
import { ConnectionError } from './publishing/connections';
import { mapPublicationParts } from './publishing/parallel';

export const MAX_MEDIA_DELETE_BATCH = 20;
/** Each item retains the single-delete lease, scope and protection checks.
 * Drain all started work and return individual failures, never lose successful
 * removals behind an error from a different item.
 */
export async function deleteMediaBatch(org: string, site: string, ids: string[], actor?: string | null) {
  const results = await mapPublicationParts(ids, async mediaId => {
    try {
      const outcome = await deleteMediaItem(org, site, mediaId, { actor });
      return outcome ? { media_id: mediaId, status: outcome.status, ...outcome.body } : { media_id: mediaId, status: 404, complete: false, error: 'Media record not found. If it was previously deleted, use remove_published_media_copies to retry remaining copies.' };
    } catch (error) {
      return { media_id: mediaId, status: error instanceof ConnectionError ? error.status : 500, complete: false,
        error: error instanceof ConnectionError ? error.message : 'Media deletion failed. Retry this item.', code: error instanceof ConnectionError ? error.code : 'media_delete_failed' };
    }
  }, 4);
  return { complete: results.every(result => result.status === 200), results };
}
