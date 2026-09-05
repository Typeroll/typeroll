import type { APIRoute } from 'astro';
import { requireFullSession } from '../../../lib/access';
import { getStore } from '../../../lib/datastore';
import { defaultSiteSettings, paths } from '@typeroll/shared';
import { reserveSite } from '../../../lib/site-create';
import type { Site } from '@typeroll/shared';
import { WorkflowEngine } from '../../../lib/workflows/engine';
import { migrationWorkflow } from '../../../lib/workflows/migration';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  const wp_url = String(form.get('wp_url') ?? '').trim();
  if (!name || !wp_url) return new Response('name and wp_url are required', { status: 400 });

  const store = getStore();
  const { siteId, site: reservedSite } = await reserveSite(session.orgId, name);

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
    console.error(`[create-and-migrate] CF provisioning failed for ${siteId}:`, e);
  }

  const site: Omit<Site, 'id'> = {
    ...reservedSite,
    name,
    hosting_adapter: 'cloudflare',
    hosting_config: hostingConfig,
    staging_url: hostingConfig?.fallback_subdomain
      ? `https://${hostingConfig.fallback_subdomain}`
      : undefined,
    source_wp_url: wp_url,
    created_at: new Date().toISOString(),
  };
  await store.updateDoc(paths.site(session.orgId, siteId), site);
  await store.setDoc(paths.settings(session.orgId, siteId), { ...defaultSiteSettings, site_name: name });

  const engine = new WorkflowEngine();
  const workflowId = await engine.create({
    orgId: session.orgId,
    siteId,
    def: migrationWorkflow,
    config: { wp_url },
    triggeredBy: 'manual',
    createdBy: session.userId,
  });
  engine.start(session.orgId, workflowId, migrationWorkflow).catch((err) => {
    console.error(`[migration ${workflowId}] failed:`, err);
  });

  return redirect(`/app/sites/${siteId}/workflows/${workflowId}`);
};
