// POST /api/sites/{siteId}/domain/activate
//
// Customer-driven gate: flip `verified` → `live`. After this call,
// publicUrlsFor reports `production = https://<domain>` and agents
// follow that as the live URL.
//
// Precondition: current domain_status must be `verified` (or already
// `live`). Trying to activate `pending` or `failed` returns 412.
//
// Body: { auto_deploy?: boolean } — defaults to true. When true, also
// enqueues a production deploy so the canonical URL + sitemap update
// in the next build. The deploy's job_id is returned alongside the
// domain state so the caller can poll progress.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { activateDomain, DomainServiceError } from '../../../../../lib/site-domain';
import { getStore } from '../../../../../lib/datastore';
import { getDeployQueue } from '../../../../../lib/deploy/queue';
import { paths } from '@typeroll/shared';

export const POST: APIRoute = async ({ cookies, params, request, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => ({}))) as { auto_deploy?: boolean };
  const autoDeploy = body.auto_deploy !== false; // default true

  try {
    const state = await activateDomain(owner_org_id, site.id);

    let deployJobId: string | undefined;
    if (autoDeploy) {
      // The canonical URL is baked at build time, so a deploy after
      // activation is what actually makes the new domain "stick" in
      // sitemap + JSON-LD + <link rel=canonical>. Default-on; opt-out
      // with auto_deploy=false.
      try {
        const store = getStore();
        deployJobId = await store.addDoc(paths.deploys(owner_org_id, site.id), {
          version_id: versionId,
          environment: 'production',
          status: 'queued',
          started_at: new Date().toISOString(),
          triggered_by: session.email ?? session.userId ?? 'domain-activate',
          source: 'domain-activate',  // audit hint
        });
        await getDeployQueue().enqueue({
          jobId: deployJobId,
          orgId: owner_org_id,
          siteId: site.id,
          versionId,
          environment: 'production',
        });
      } catch (e) {
        // The activation itself succeeded — only the auto-deploy failed.
        // Return success on the activation but surface the deploy error
        // so the UI can prompt the customer to retry from the deploy
        // panel manually.
        return json({
          domain: state,
          deploy: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    return json({ domain: state, ...(deployJobId ? { deploy: { job_id: deployJobId } } : {}) });
  } catch (e) {
    if (e instanceof DomainServiceError) return json({ error: e.message }, e.status);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};
