import { createHash } from 'node:crypto';
import { MEDIA_RECIPE_VERSION } from './media-recipe.mjs';
import { mediaReceiptKey } from './media-receipt.mjs';

/** A prior completed build proves preparation, not current availability.
 * Materialization still reads and verifies the selected files and receipts.
 */
function receiptKeys(publication) {
  const manifests = [...publication.retained_media_manifests ?? [], ...publication.media_manifest ? [publication.media_manifest] : []];
  const keys = manifests.flatMap(manifest => manifest.entries.map(entry => mediaReceiptKey(manifest, entry))).sort();
  return keys;
}
export function mediaPreparationScope(publication) {
  const keys = receiptKeys(publication);
  return { recipe: MEDIA_RECIPE_VERSION, scope: createHash('sha256').update(JSON.stringify(keys)).digest('hex'), total: keys.length };
}
export function freezeMediaPreparation(publication, previous, previousPrepared = false) {
  const current = mediaPreparationScope(publication);
  const prior = previous?.media_preparation_scope;
  let reused = previousPrepared && prior?.recipe === current.recipe && prior?.scope === current.scope && prior?.total === current.total;
  if (!reused && previousPrepared && prior?.recipe === current.recipe && current.total <= prior?.total) {
    const previousScope = mediaPreparationScope(previous);
    const known = new Set(receiptKeys(previous));
    reused = previousScope.scope === prior.scope && previousScope.total === prior.total && receiptKeys(publication).every(key => known.has(key));
  }
  return { ...current, reused, cursor: reused ? current.total : 0 };
}
