// Archive or restore a site. The one implementation behind the portal's
// session route (/api/sites/{siteId}/lifecycle) and the public API route
// (/api/v1/sites/{siteId}/lifecycle), so a person in the UI and an agent with
// an API key get the same rules and the same answers.
//
// Archiving is the portal's whole lifecycle vocabulary on purpose. Everything
// destructive — R2 objects that are shared across an organization, the
// customer's Git repository, the Cloudflare Pages project, private app
// databases — is owned by systems the portal does not control, so destroying a
// site is an operator procedure that reads this state as its precondition.
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
    if (site.domain && (site.domain_status === 'live' || site.domain_status === 'verified')) {
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

  // Restore. `null` rather than a deleted key so the write is a plain field
  // update on every datastore backend.
  await getStore().updateDoc(paths.site(ownerOrgId, site.id), { lifecycle: null });
  return { status: 200, body: { status: 'active', site: site.id } };
}
