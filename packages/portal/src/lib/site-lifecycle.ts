// Archive or restore a site. The one implementation behind the portal's
// session route (/api/sites/{siteId}/lifecycle) and the public API route
// (/api/v1/sites/{siteId}/lifecycle), so a person in the UI and an agent with
// an API key get the same rules and the same answers.
//
// Archiving is reversible and deletes nothing. Permanent deletion is a
// separate owner-only step with this state as its precondition
// (lib/site-deletion.ts); it removes the site's documents and leaves what
// lives in the customer's own accounts — the Git repository, the Cloudflare
// Pages project, DNS — untouched and listed.
//
// What archiving actually does is enforced by the write guards
// (lib/access.ts → requirePermission, lib/api-auth.ts → requireApiKey): every
// write above `read` is refused, which is what stops an agent, an API key or a
// bookmarked URL from carrying on as if nothing happened. Authorization (owner
// organization, admin) is the caller's job and differs only in how the
// credential is read.

import { ARCHIVED_SITE_MESSAGE, isArchivedSite, paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { getStore } from './datastore';
import { generatedCloudflareNames } from './publishing/cloudflare-account-claims';

export type SiteLifecycleAction = 'archive' | 'restore';

export interface SiteLifecycleOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** Current lifecycle state, in the shape both routes report. */
export function siteLifecycleState(site: Pick<Site, 'lifecycle'>): Record<string, unknown> {
  if (!isArchivedSite(site)) return { status: 'active' };
  const lifecycle = site.lifecycle!;
  return {
    status: 'archived',
    archived_at: lifecycle.archived_at,
    archived_by: lifecycle.archived_by,
    ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
  };
}

/** Whether `host` is the generated address Core publishes a site at before it has a domain. */
export function isGeneratedSiteAddress(orgId: string, siteId: string, host: string): boolean {
  return host.toLowerCase().split('.')[0] === generatedCloudflareNames(orgId, siteId).site_label;
}

/**
 * The custom domain that still serves this site, or null. A domain that is
 * live or verified keeps answering visitors from the last publication; the
 * site's generated address is not a customer's domain and does not count.
 */
export function servedCustomDomain(ownerOrgId: string, site: Pick<Site, 'id' | 'domain' | 'domain_status'>): string | null {
  if (!site.domain || (site.domain_status !== 'live' && site.domain_status !== 'verified')) return null;
  return isGeneratedSiteAddress(ownerOrgId, site.id, site.domain) ? null : site.domain;
}

/**
 * Apply `action` to `site`. `actor` is recorded as `archived_by`: a user id for
 * a session, `api-key:<prefix>` for an API key.
 *
 * Idempotent: asking for the state a site is already in is a success, so a
 * retried request or a double-submitted form does not read as a failure.
 */
export async function changeSiteLifecycle(input: {
  ownerOrgId: string;
  site: Site & { id: string };
  action: unknown;
  reason?: unknown;
  actor: string;
}): Promise<SiteLifecycleOutcome> {
  const { ownerOrgId, site, actor } = input;
  const action = String(input.action ?? '');
  if (action !== 'archive' && action !== 'restore') {
    return { status: 400, body: { error: "action must be 'archive' or 'restore'" } };
  }

  const archived = isArchivedSite(site);
  if (action === 'archive' && archived) return { status: 200, body: { status: 'archived', site: site.id } };
  if (action === 'restore' && !archived) return { status: 200, body: { status: 'active', site: site.id } };

  if (action === 'archive') {
    // A live custom domain still serves visitors from the last published
    // artifact, and archiving does not take it down — publishing is what stops.
    // Refusing here keeps the operator from inheriting a retired site that is
    // still the public face of a customer's domain.
    // The site's generated address (site-<label>.<sites domain>) is not a
    // customer's domain: it belongs to the organization's hosting and stays
    // with the archived site, like the last publication.
    if (servedCustomDomain(ownerOrgId, site)) {
      return {
        status: 409,
        body: {
          error:
            `This site still serves ${site.domain}. Move or remove the domain before archiving, ` +
            'otherwise the live site would keep answering with no way to update it.',
        },
      };
    }
    const reason = String(input.reason ?? '').trim().slice(0, 500);
    const lifecycle: NonNullable<Site['lifecycle']> = {
      status: 'archived',
      archived_at: new Date().toISOString(),
      archived_by: actor,
      ...(reason ? { reason } : {}),
    };
    await getStore().updateDoc(paths.site(ownerOrgId, site.id), { lifecycle });
    return { status: 200, body: { status: 'archived', site: site.id, message: ARCHIVED_SITE_MESSAGE } };
  }

  // A started deletion has already removed part of the site; restoring would
  // revive a site with missing content. Finishing the deletion is the way out.
  if (site.lifecycle?.deletion) {
    return {
      status: 409,
      body: {
        error: 'This site is being permanently deleted and cannot be restored. Finish the deletion with POST /api/v1/sites/{siteId}/deletion.',
        code: 'site_deletion_in_progress',
        details: { audit_id: site.lifecycle.deletion.audit_id },
      },
    };
  }

  // Restore. `null` rather than a deleted key so the write is a plain field
  // update on every datastore backend.
  await getStore().updateDoc(paths.site(ownerOrgId, site.id), { lifecycle: null });
  return { status: 200, body: { status: 'active', site: site.id } };
}
