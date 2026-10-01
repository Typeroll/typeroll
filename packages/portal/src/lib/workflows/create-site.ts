// Create a new site and immediately start the workflow that fills it:
// WordPress migration or AI site planning. The one implementation behind the
// "New site" forms (/api/sites/create-and-migrate, /api/sites/create-and-plan)
// and the public API (/api/v1/sites/create-and-migrate, .../create-and-plan).
//
// Unlike lib/site-create's blank-site bootstrap, no home page or header and
// footer are seeded: the workflow produces the site's content.

import { defaultSiteSettings, newSiteStyles, paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { requireImportStorage } from '../media/import-policy';
import { reserveSite } from '../site-create';
import { WorkflowEngine } from './engine';
import { migrationWorkflow } from './migration';
import { sitePlanningWorkflow } from './site-planning';

export class SiteWorkflowInputError extends Error {}

export type SiteWorkflowRequest =
  | { kind: 'migration'; name: string; wp_url: string; helper_api_key?: string }
  | { kind: 'site_planning'; name: string; business_description: string };

/** Validate the fields the "New site" forms ask for. */
export function parseSiteWorkflowRequest(kind: 'migration' | 'site_planning', input: Record<string, unknown>): SiteWorkflowRequest {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '');
  const name = text('name');
  if (kind === 'migration') {
    const wp_url = text('wp_url');
    if (!name || !wp_url) throw new SiteWorkflowInputError('name and wp_url are required');
    let url: URL;
    try { url = new URL(wp_url); } catch { throw new SiteWorkflowInputError('wp_url must be an absolute http(s) URL'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SiteWorkflowInputError('wp_url must be an absolute http(s) URL');
    const helper = text('helper_api_key');
    return { kind, name, wp_url, ...(helper ? { helper_api_key: helper } : {}) };
  }
  const business_description = text('business_description');
  if (!name || !business_description) throw new SiteWorkflowInputError('name and business_description required');
  return { kind, name, business_description };
}

/**
 * Reserve, provision and configure a site under `orgId`, then start the
 * requested workflow in the background. Migration checks the organization's
 * import storage before anything is created and throws its ConnectionError.
 */
export async function createSiteWithWorkflow(input: {
  orgId: string;
  request: SiteWorkflowRequest;
  createdBy: string;
}): Promise<{ siteId: string; workflowId: string; site: Site & { id: string } }> {
  const { orgId, request } = input;
  if (request.kind === 'migration') await requireImportStorage(orgId);

  const store = getStore();
  const { siteId, site: reservedSite } = await reserveSite(orgId, request.name);

  let hostingConfig: Site['hosting_config'] | undefined;
  try {
    const { provisionSiteHosting } = await import('../hosting/site-provisioning');
    const result = await provisionSiteHosting(orgId, siteId);
    if (result) {
      hostingConfig = {
        pages_project: result.pagesProject,
        fallback_subdomain: result.fallbackSubdomain ?? undefined,
      };
    }
  } catch (e) {
    console.error(`[create-and-${request.kind === 'migration' ? 'migrate' : 'plan'}] CF provisioning failed for ${siteId}:`, e);
  }

  const site: Omit<Site, 'id'> = {
    ...reservedSite,
    name: request.name,
    hosting_adapter: 'cloudflare',
    hosting_config: hostingConfig,
    staging_url: hostingConfig?.fallback_subdomain
      ? `https://${hostingConfig.fallback_subdomain}`
      : undefined,
    ...(request.kind === 'migration' ? { source_wp_url: request.wp_url } : {}),
    created_at: new Date().toISOString(),
  };
  await store.updateDoc(paths.site(orgId, siteId), site);
  await store.setDoc(paths.settings(orgId, siteId), { ...defaultSiteSettings, styles: newSiteStyles(), site_name: request.name });

  const def = request.kind === 'migration' ? migrationWorkflow : sitePlanningWorkflow;
  const config: Record<string, unknown> = request.kind === 'migration'
    ? { wp_url: request.wp_url, ...(request.helper_api_key ? { helper_api_key: request.helper_api_key } : {}) }
    : { business_description: request.business_description };
  const engine = new WorkflowEngine();
  const workflowId = await engine.create({
    orgId,
    siteId,
    def,
    config,
    triggeredBy: 'manual',
    createdBy: input.createdBy,
  });
  engine.start(orgId, workflowId, def).catch((err) => {
    console.error(`[${request.kind} ${workflowId}] failed:`, err);
  });

  return { siteId, workflowId, site: { ...(site as Site), id: siteId } };
}
