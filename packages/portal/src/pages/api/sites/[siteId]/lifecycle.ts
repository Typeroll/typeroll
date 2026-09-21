// Retire a site, or bring it back.
//
// Archiving is the portal's whole lifecycle vocabulary on purpose. Everything
// destructive — R2 objects that are shared across an organization, the
// customer's Git repository, the Cloudflare Pages project, private app
// databases — is owned by systems the portal does not control, so destroying a
// site is an operator procedure that reads this state as its precondition.
//
// What archiving actually does is in lib/access.ts: requirePermission refuses
// every write above `read`, which is what stops an agent, an API key or a
// bookmarked URL from carrying on as if nothing happened.

import type { APIRoute } from 'astro';
import { ARCHIVED_SITE_MESSAGE, isArchivedSite, paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { requireSiteAccess, requireSiteLifecycleChange, json } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const allowed = requireSiteLifecycleChange(guard.value);
  if (!allowed.ok) return allowed.response;
  const { session, site, owner_org_id } = guard.value;

  // Accepts a form post from the settings page and a JSON body from the API,
  // because this is reachable from both and neither should be the odd one out.
  const contentType = request.headers.get('content-type') ?? '';
  const body: Record<string, unknown> = contentType.includes('application/json')
    ? await request.json().catch(() => ({}))
    : Object.fromEntries(await request.formData());

  const action = String(body.action ?? '');
  if (action !== 'archive' && action !== 'restore') {
    return json({ error: "action must be 'archive' or 'restore'" }, 400);
  }

  const archived = isArchivedSite(site);
  // Idempotent: asking for the state a site is already in is a success, so a
  // retried request or a double-submitted form does not read as a failure.
  if (action === 'archive' && archived) return json({ status: 'archived', site: site.id });
  if (action === 'restore' && !archived) return json({ status: 'active', site: site.id });

  if (action === 'archive') {
    // A live custom domain still serves visitors from the last published
    // artifact, and archiving does not take it down — publishing is what stops.
    // Refusing here keeps the operator from inheriting a retired site that is
    // still the public face of a customer's domain.
    if (site.domain && (site.domain_status === 'live' || site.domain_status === 'verified')) {
      return json(
        {
          error:
            `This site still serves ${site.domain}. Move or remove the domain before archiving, ` +
            'otherwise the live site would keep answering with no way to update it.',
        },
        409,
      );
    }
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    const lifecycle: NonNullable<Site['lifecycle']> = {
      status: 'archived',
      archived_at: new Date().toISOString(),
      archived_by: session.userId,
      ...(reason ? { reason } : {}),
    };
    await getStore().updateDoc(paths.site(owner_org_id, site.id), { lifecycle });
    return json({ status: 'archived', site: site.id, message: ARCHIVED_SITE_MESSAGE });
  }

  // Restore. `null` rather than a deleted key so the write is a plain field
  // update on every datastore backend.
  await getStore().updateDoc(paths.site(owner_org_id, site.id), { lifecycle: null });
  return json({ status: 'active', site: site.id });
};
