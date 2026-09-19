// Coalesced auto-deploy.
//
// Every deploy is otherwise explicit: the editor button, the API, domain
// activation, the publish sweep. That's right for a marketing site edited
// twice a week and wrong for a directory whose enrichment agent writes forty
// records in a minute — nobody wants forty builds, and nobody wants to press
// Deploy forty times either.
//
// A dirty marker is indexed atomically with its site write. Its explicit
// debounce schedules one site publication. A revision distinguishes edits
// arriving during dispatch even when the oldest pending timestamp is unchanged.

import { randomUUID } from 'node:crypto';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { getStore } from './datastore';

export const DEFAULT_DEBOUNCE_MINUTES = 15;

/**
 * Record that a site has unpublished content changes.
 *
 * Preserves the oldest pending timestamp and advances the edit revision. The value is the age of the oldest
 * pending edit, which is what a debounce window measures — refreshing it on
 * every write would let a steady trickle of edits postpone the build forever.
 *
 * Best-effort by design: this is called from commit paths whose actual job is
 * saving the user's content, and a failed marker write must never fail the
 * save. The worst case is a delayed deploy, and the next write re-stamps.
 */
export async function markSiteDirty(orgId: string, siteId: string, versionId: string): Promise<void> {
  // Preview versions cannot schedule a main publication or advance its revision.
  if (versionId !== MAIN_VERSION_ID) return;
  try {
    const store = getStore();
    const site = await store.getDoc<Site>(paths.site(orgId, siteId));
    if (!site?.auto_deploy?.enabled) return;

    await store.updateDoc(paths.site(orgId, siteId), {
      pending_deploy_at: site.pending_deploy_at ?? new Date().toISOString(),
      pending_deploy_revision: randomUUID(),
    });
  } catch {
    /* never break a content save over a deploy hint */
  }
}

/**
 * Has this site's oldest pending edit aged past its debounce window?
 * Pure so the sweep's decision is testable without a datastore.
 */
export function isDeployDue(site: Site, now: Date = new Date()): boolean {
  if (!site.auto_deploy?.enabled) return false;
  const pending = site.pending_deploy_at;
  if (!pending) return false;
  const started = Date.parse(pending);
  if (Number.isNaN(started)) return false;
  const minutes = site.auto_deploy.debounce_minutes ?? DEFAULT_DEBOUNCE_MINUTES;
  return now.getTime() - started >= minutes * 60_000;
}

/**
 * Clear the marker. Called when the deploy is ENQUEUED rather than when it
 * finishes: a write that lands mid-build re-stamps it and gets picked up by
 * the next sweep, whereas clearing on completion would swallow that edit.
 */
export async function clearDirtyMarker(orgId: string, siteId: string): Promise<void> {
  try {
    await getStore().updateDoc(paths.site(orgId, siteId), { pending_deploy_at: null });
  } catch {
    /* a stale marker just means one redundant build next sweep */
  }
}
