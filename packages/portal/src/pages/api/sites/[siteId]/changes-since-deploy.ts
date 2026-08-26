// What has changed since the live site was last built? Powers the Publish
// menu's "Redeploy full site" section so the user sees exactly what a
// redeploy would ship (and what it wouldn't — drafts stay behind).
//
// Computed at read time from date_updated/updated_at stamps vs the active
// version's last_deployed_at; nothing is stored, so it can't go stale.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../lib/access';
import { vstore } from '../../../../lib/version-store';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

interface Change {
  kind: 'page' | 'partial' | 'collection_item' | 'template';
  id: string;
  title: string;
  date_updated: string;
  status?: string;
  /** Whether the next deploy would actually include this doc. */
  will_deploy: boolean;
  /** For collection_item: which collection it belongs to. */
  collection?: string;
}

const SHIPPING_STATUSES = new Set(['published', 'unlisted']);
const MAX_CHANGES = 50;

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id: orgId } = guard.value;

  const version = await getStore().getDoc<SiteVersion>(
    paths.version(orgId, site.id, versionId),
  );
  const last = version?.last_deployed_at ?? null;
  const changedSince = (stamp?: string) => !!stamp && (!last || stamp > last);

  const changes: Change[] = [];

  const pages = await vstore.pages(orgId, site.id, versionId);
  for (const p of pages) {
    if (!changedSince(p.date_updated)) continue;
    changes.push({
      kind: 'page',
      id: p.id,
      title: p.title || p.slug || p.id,
      date_updated: p.date_updated!,
      status: p.status,
      will_deploy: SHIPPING_STATUSES.has(p.status),
    });
  }

  const partials = await vstore.partials(orgId, site.id, versionId);
  for (const pt of partials) {
    if (!changedSince(pt.date_updated)) continue;
    changes.push({
      kind: 'partial',
      id: pt.id,
      title: pt.name || pt.id,
      date_updated: pt.date_updated!,
      status: pt.status,
      will_deploy: pt.status === 'published',
    });
  }

  const templates = await vstore.pageTemplates(orgId, site.id, versionId);
  for (const t of templates) {
    const stamp = (t as { date_updated?: string }).date_updated;
    if (!changedSince(stamp)) continue;
    changes.push({
      kind: 'template',
      id: t.id,
      title: (t as { name?: string }).name || t.id,
      date_updated: stamp!,
      // Templates always ship — pages decide whether they're used.
      will_deploy: true,
    });
  }

  const collections = await vstore.collections(orgId, site.id, versionId);
  for (const c of collections) {
    const items = await vstore.collectionItems(orgId, site.id, versionId, c.name);
    for (const it of items) {
      const stamp = (it as { updated_at?: string }).updated_at;
      if (!changedSince(stamp)) continue;
      const status = String((it as { status?: string }).status ?? 'draft');
      changes.push({
        kind: 'collection_item',
        id: it.id,
        title: String(
          (it as Record<string, unknown>).title
            ?? (it as Record<string, unknown>).name
            ?? it.id,
        ),
        date_updated: stamp!,
        status,
        will_deploy: status === 'published',
        collection: c.name,
      });
    }
  }

  changes.sort((a, b) => (a.date_updated < b.date_updated ? 1 : -1));
  return json({
    last_deployed_at: last,
    never_deployed: !last,
    total: changes.length,
    changes: changes.slice(0, MAX_CHANGES),
  });
};
