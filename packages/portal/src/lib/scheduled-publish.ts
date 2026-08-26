// Scheduled publishing sweep. Scans every org/site's MAIN version for
// pages and collection items whose publish_at / unpublish_at has come due,
// flips their status, and enqueues ONE deploy per affected site so the
// change actually reaches the live static site.
//
// Sweep-not-task-per-doc keeps this idempotent by construction: firing is
// gated on the doc's CURRENT status, the schedule field is cleared on
// fire, and a re-run (Cloud Scheduler is at-least-once) finds nothing due.
// Cadence comes from the caller: Cloud Scheduler hits
// /api/internal/publish-sweep every few minutes in production; local dev
// runs an in-process interval (see middleware.ts).
//
// MAIN version only, deliberately: schedules are about the live site.
// Branch content goes live by merging, and a release-level schedule is the
// Releases feature's job (world-class plan #9), which reuses this sweep.

import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { CollectionDef, CollectionItem, DeployJob, Page, Site } from '@typeroll/shared';
import { getStore } from './datastore';
import { getDeployQueue } from './deploy/queue';
import { findActiveDeploy } from './deploy/in-flight';
import { clearDirtyMarker, isDeployDue } from './auto-deploy';

export interface SweepResult {
  pages_published: number;
  pages_unpublished: number;
  items_published: number;
  items_unpublished: number;
  /** site keys ("orgId/siteId") that got a deploy enqueued */
  deployed: string[];
  /** Subset of `deployed` triggered by pending edits rather than a schedule. */
  auto_deployed: string[];
  /**
   * Sites that needed a build but already had one in flight. Their dirty
   * marker is deliberately left set, so the next sweep picks them up — but a
   * site appearing here every run means builds are slower than the sweep
   * cadence, which is worth seeing rather than inferring.
   */
  skipped_in_flight: string[];
  errors: string[];
}

const due = (v: unknown, nowIso: string): boolean => typeof v === 'string' && v !== '' && v <= nowIso;

export async function runPublishSweep(now: Date = new Date()): Promise<SweepResult> {
  const nowIso = now.toISOString();
  const store = getStore();
  const result: SweepResult = {
    pages_published: 0, pages_unpublished: 0,
    items_published: 0, items_unpublished: 0,
    deployed: [], auto_deployed: [], skipped_in_flight: [], errors: [],
  };
  const affected = new Set<string>();
  // Sites whose dirty marker must be cleared once their build is queued.
  const dirtyCleared = new Set<string>();

  let orgs: Array<{ id: string }> = [];
  try {
    orgs = await store.listDocs<{ id: string }>('organizations');
  } catch {
    return result; // no orgs collection yet — nothing to sweep
  }

  for (const org of orgs) {
    let sites: Array<{ id: string }> = [];
    try {
      sites = await store.listDocs<{ id: string }>(paths.sites(org.id));
    } catch { continue; }

    for (const site of sites) {
      const key = `${org.id}/${site.id}`;
      try {
        // Pages (main version — schedules target the live site).
        const pages = await store.listDocs<Page>(paths.pages(org.id, site.id, MAIN_VERSION_ID));
        for (const p of pages) {
          if (due(p.publish_at, nowIso) && p.status !== 'published') {
            await store.updateDoc(`${paths.pages(org.id, site.id, MAIN_VERSION_ID)}/${p.id}`, {
              status: 'published',
              date_published: p.date_published ?? nowIso,
              publish_at: null,
            });
            result.pages_published++;
            affected.add(key);
          } else if (due(p.unpublish_at, nowIso) && p.status === 'published') {
            await store.updateDoc(`${paths.pages(org.id, site.id, MAIN_VERSION_ID)}/${p.id}`, {
              status: 'draft',
              unpublish_at: null,
            });
            result.pages_unpublished++;
            affected.add(key);
          }
        }

        // Collection items.
        const collections = await store.listDocs<CollectionDef & { name?: string }>(
          paths.collections(org.id, site.id, MAIN_VERSION_ID),
        );
        for (const coll of collections) {
          const collName = coll.name ?? coll.id;
          const itemsPath = paths.collectionItems(org.id, site.id, collName, MAIN_VERSION_ID);
          const items = await store.listDocs<CollectionItem>(itemsPath);
          for (const item of items) {
            if (due(item.publish_at, nowIso) && item.status !== 'published') {
              await store.updateDoc(`${itemsPath}/${item.id}`, {
                status: 'published',
                updated_at: nowIso,
                publish_at: null,
              });
              result.items_published++;
              affected.add(key);
            } else if (due(item.unpublish_at, nowIso) && item.status === 'published') {
              await store.updateDoc(`${itemsPath}/${item.id}`, {
                status: 'draft',
                updated_at: nowIso,
                unpublish_at: null,
              });
              result.items_unpublished++;
              affected.add(key);
            }
          }
        }
        // Auto-deploy: a site whose oldest pending edit has aged past its
        // debounce window joins the same `affected` set, so a site with both
        // due schedules and pending edits still gets exactly one build.
        const siteDoc = await store.getDoc<Site>(paths.site(org.id, site.id));
        if (siteDoc && isDeployDue(siteDoc, now)) {
          affected.add(key);
          dirtyCleared.add(key);
          result.auto_deployed.push(key);
        }
      } catch (e) {
        result.errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // One deploy per affected site — after all its flips, so a site with
  // several due docs ships them in a single build.
  for (const key of affected) {
    const [orgId, siteId] = key.split('/');
    try {
      // Skip a site that is already building, and — critically — do NOT clear
      // its dirty marker. The marker is what brings us back: leaving it set
      // means the next sweep re-enqueues once the current build is done, while
      // clearing it here would drop the edits that made the site dirty.
      const active = findActiveDeploy(
        await store.listDocs<DeployJob>(paths.deploys(orgId, siteId)).catch(() => []),
      );
      if (active) {
        result.skipped_in_flight.push(key);
        continue;
      }

      const jobId = await store.addDoc(paths.deploys(orgId, siteId), {
        version_id: MAIN_VERSION_ID,
        environment: 'production',
        status: 'queued',
        started_at: nowIso,
        triggered_by: 'scheduled-publish',
      });
      await getDeployQueue().enqueue({
        jobId,
        orgId,
        siteId,
        versionId: MAIN_VERSION_ID,
        environment: 'production',
      });
      result.deployed.push(key);
      // Clear on ENQUEUE, not on completion — an edit landing mid-build
      // re-stamps the marker and gets picked up next sweep. Clearing later
      // would swallow it.
      if (dirtyCleared.has(key)) await clearDirtyMarker(orgId, siteId);
    } catch (e) {
      result.errors.push(`deploy ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
