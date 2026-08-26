import type { APIRoute } from 'astro';
import { requireFullSession } from '../../../lib/access';
import { getStore, generateDocId } from '../../../lib/datastore';
import { defaultSiteSettings, paths, slugify } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { WorkflowEngine } from '../../../lib/workflows/engine';
import { sitePlanningWorkflow } from '../../../lib/workflows/site-planning';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  const business_description = String(form.get('business_description') ?? '').trim();
  if (!name || !business_description) return new Response('name and business_description required', { status: 400 });

  const store = getStore();
  const siteId = slugify(name) || generateDocId();

  let hostingConfig: Site['hosting_config'] | undefined;
  try {
    const { provisionSiteHosting } = await import('../../../lib/hosting/site-provisioning');
    const result = await provisionSiteHosting(session.orgId, siteId);
    if (result) {
      hostingConfig = {
        pages_project: result.pagesProject,
        fallback_subdomain: result.fallbackSubdomain ?? undefined,
      };
    }
  } catch (e) {
    console.error(`[create-and-plan] CF provisioning failed for ${siteId}:`, e);
  }

  const site: Omit<Site, 'id'> = {
    name,
    hosting_adapter: 'cloudflare',
    hosting_config: hostingConfig,
    staging_url: hostingConfig?.fallback_subdomain
      ? `https://${hostingConfig.fallback_subdomain}`
      : undefined,
    created_at: new Date().toISOString(),
  };
  await store.setDoc(paths.site(session.orgId, siteId), site);
  await store.setDoc(paths.settings(session.orgId, siteId), { ...defaultSiteSettings, site_name: name });

  const engine = new WorkflowEngine();
  const workflowId = await engine.create({
    orgId: session.orgId,
    siteId,
    def: sitePlanningWorkflow,
    config: { business_description },
    triggeredBy: 'manual',
    createdBy: session.userId,
  });
  engine.start(session.orgId, workflowId, sitePlanningWorkflow).catch((err) => {
    console.error(`[site_planning ${workflowId}] failed:`, err);
  });

  return redirect(`/app/sites/${siteId}/workflows/${workflowId}`);
};
