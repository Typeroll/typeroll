// Custom-domain CRUD for a site. Admin-only.
//
//   GET    /api/sites/{siteId}/domain   — read current state
//   POST   /api/sites/{siteId}/domain   — declare the domain. In the
//                                         domain-first model this is the
//                                         step that makes the domain the
//                                         canonical host: by default it also
//                                         republishes so sitemap + canonical
//                                         bake the new host immediately. The
//                                         customer points DNS at us AFTER.
//                                         body: { hostname, prefer?, auto_deploy? }
//   DELETE /api/sites/{siteId}/domain   — detach the domain
//
// `poll` (DNS-health check) lives in a sibling file. `activate` is retained
// for back-compat but is no longer part of the flow — declaring the domain
// is what cuts the canonical over. See docs/domain-lifecycle-plan.md.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import {
  requestDomain,
  removeDomain,
  getDomainState,
  DomainServiceError,
} from '../../../../../lib/site-domain';
import { getStore } from '../../../../../lib/datastore';
import { getDeployQueue } from '../../../../../lib/deploy/queue';
import { paths } from '@typeroll/shared';

function fail(e: unknown): Response {
  if (e instanceof DomainServiceError) return json({ error: e.message }, e.status);
  const msg = e instanceof Error ? e.message : String(e);
  return json({ error: msg }, 500);
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  try {
    const state = await getDomainState(owner_org_id, site.id);
    return json({ domain: state });
  } catch (e) {
    return fail(e);
  }
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => null)) as {
    hostname?: string;
    /** 'apex' (default) | 'www' — which variant of an apex/www pair
     *  becomes canonical. Ignored for subdomain inputs. */
    prefer?: 'apex' | 'www';
    /** Default true. Republish the production build right after declaring the
     *  domain so the new canonical/sitemap/robots go live immediately — the
     *  "publish now" checkbox in the UI. Opt out with auto_deploy=false to
     *  declare the domain without shipping a build yet. */
    auto_deploy?: boolean;
  } | null;
  if (!body?.hostname || typeof body.hostname !== 'string') {
    return json({ error: 'hostname is required' }, 400);
  }
  const prefer = body.prefer === 'www' ? 'www' : 'apex';
  const autoDeploy = body.auto_deploy !== false; // default true
  try {
    const state = await requestDomain(owner_org_id, site.id, body.hostname, { prefer });

    // Domain-first: declaring the domain is what makes it canonical, and the
    // canonical is baked at build time — so republish now (default) to push
    // the new sitemap + <link rel=canonical> + robots host-routing. Opt-out
    // leaves the setting changed but unpublished.
    let deployJobId: string | undefined;
    if (autoDeploy) {
      try {
        const store = getStore();
        deployJobId = await store.addDoc(paths.deploys(owner_org_id, site.id), {
          version_id: versionId,
          environment: 'production',
          status: 'queued',
          started_at: new Date().toISOString(),
          triggered_by: session.email ?? session.userId ?? 'domain-declare',
          source: 'domain-declare',
        });
        await getDeployQueue().enqueue({
          jobId: deployJobId,
          orgId: owner_org_id,
          siteId: site.id,
          versionId,
          environment: 'production',
        });
      } catch (e) {
        // Domain was declared fine; only the republish failed. Surface it so
        // the UI can offer a manual deploy without losing the domain change.
        return json({ domain: state, deploy: { error: e instanceof Error ? e.message : String(e) } });
      }
    }

    return json({ domain: state, ...(deployJobId ? { deploy: { job_id: deployJobId } } : {}) });
  } catch (e) {
    return fail(e);
  }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  try {
    await removeDomain(owner_org_id, site.id);
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
};
