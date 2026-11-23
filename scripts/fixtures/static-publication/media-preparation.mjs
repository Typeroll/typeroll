import { createHash } from 'node:crypto';
import { MEDIA_RECIPE_VERSION } from './media-recipe.mjs';
import { mediaReceiptKey } from './media-receipt.mjs';

/** A prior completed build proves preparation, not current availability.
 * Materialization still reads and verifies the selected files and receipts.
 */
export function mediaPreparationScope(publication) {
  const manifests = [...publication.retained_media_manifests ?? [], ...publication.media_manifest ? [publication.media_manifest] : []];
  const keys = manifests.flatMap(manifest => manifest.entries.map(entry => mediaReceiptKey(manifest, entry))).sort();
  return { recipe: MEDIA_RECIPE_VERSION, scope: createHash('sha256').update(JSON.stringify(keys)).digest('hex'), total: keys.length };
}
export function freezeMediaPreparation(publication, previous, previousPrepared = false) {
  const current = mediaPreparationScope(publication);
  const prior = previous?.media_preparation_scope;
  const reused = previousPrepared && prior?.recipe === current.recipe && prior?.scope === current.scope && prior?.total === current.total;
  return { ...current, reused, cursor: reused ? current.total : 0 };
}
