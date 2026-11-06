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
import { requireAiForNewSite } from '../ai/organization-ai';
import { reserveSite } from '../site-create';
import { parseNewSiteOptions } from '../site-create-input';
import { WorkflowEngine } from './engine';
import { workflowChunkQueue } from './queue';
import { migrationWorkflow } from './migration';
import { sitePlanningWorkflow } from './site-planning';
import { migrationSourcePolicy, parseOutboundUrl } from '../net/safe-fetch';

export class SiteWorkflowInputError extends Error {}

/** Optional id and language of the new site (site-create-input.ts). */
interface NewSiteOptions { id?: string; language?: string }

export type SiteWorkflowRequest =
  | ({ kind: 'migration'; name: string; wp_url: string; helper_api_key?: string } & NewSiteOptions)
  | ({ kind: 'site_planning'; name: string; business_description: string } & NewSiteOptions);

/** Every field each public create-with-workflow route accepts. */
export const SITE_WORKFLOW_FIELDS = {
  migration: ['name', 'id', 'language', 'wp_url', 'helper_api_key'],
  site_planning: ['name', 'id', 'language', 'business_description'],
} as const;

/** Validate the fields the "New site" forms ask for. */
export function parseSiteWorkflowRequest(kind: 'migration' | 'site_planning', input: Record<string, unknown>): SiteWorkflowRequest {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '');
  const name = text('name');
  const parsed = parseNewSiteOptions(input);
  if (parsed.error !== undefined) throw new SiteWorkflowInputError(parsed.error);
  const options: NewSiteOptions = { ...(parsed.id ? { id: parsed.id } : {}), ...(parsed.language ? { language: parsed.language } : {}) };
  if (kind === 'migration') {
    const wp_url = text('wp_url');
    if (!name || !wp_url) throw new SiteWorkflowInputError('name and wp_url are required');
    // Host names are re-checked against DNS on every source request.
    try { parseOutboundUrl(wp_url, migrationSourcePolicy()); } catch { throw new SiteWorkflowInputError('wp_url must be an absolute public http(s) URL'); }
    const helper = text('helper_api_key');
    return { kind, name, wp_url, ...(helper ? { helper_api_key: helper } : {}), ...options };
  }
  const business_description = text('business_description');
  if (!name || !business_description) throw new SiteWorkflowInputError('name and business_description required');
  return { kind, name, business_description, ...options };
}

/**
 * Reserve, provision and configure a site under `orgId`, then start the
 * requested workflow in the background. Migration checks the organization's
 * import storage before anything is created and throws its ConnectionError.
 * AI site planning checks that the organization's AI key covers new sites
 * (a key and "all sites") before anything is created and throws
 * AiNotEnabledError (ai_not_enabled) otherwise.
 */
export async function createSiteWithWorkflow(input: {
  orgId: string;
  request: SiteWorkflowRequest;
  createdBy: string;
}): Promise<{ siteId: string; workflowId: string; site: Site & { id: string } }> {
  const { orgId, request } = input;
  if (request.kind === 'migration') await requireImportStorage(orgId);
  if (request.kind === 'site_planning') await requireAiForNewSite(orgId);

  const store = getStore();
  const { siteId, site: reservedSite } = await reserveSite(orgId, request.name, { id: request.id, language: request.language });

  const site: Omit<Site, 'id'> = {
    ...reservedSite,
    name: request.name,
    hosting_adapter: 'cloudflare',
    ...(request.kind === 'migration' ? { source_wp_url: request.wp_url } : {}),
    created_at: new Date().toISOString(),
  };
  await store.updateDoc(paths.site(orgId, siteId), site);
  await store.setDoc(paths.settings(orgId, siteId), { ...defaultSiteSettings, styles: newSiteStyles(), site_name: request.name, ...(request.language ? { language: request.language } : {}) });

  const def = request.kind === 'migration' ? migrationWorkflow : sitePlanningWorkflow;
  const config: Record<string, unknown> = request.kind === 'migration'
    ? { wp_url: request.wp_url, ...(request.helper_api_key ? { helper_api_key: request.helper_api_key } : {}) }
    : { business_description: request.business_description };
  const engine = new WorkflowEngine(getStore(), { queue: workflowChunkQueue() });
  const workflowId = await engine.create({
    orgId,
    siteId,
    def,
    config,
    triggeredBy: 'manual',
    createdBy: input.createdBy,
  });
  // Enqueues the first chunk; the run continues in requests of its own.
  // Awaited, so the enqueue is durable before the response. A failure here
  // does not undo the site: a read later resumes or closes the run.
  await engine.start(orgId, workflowId, def).catch((err) => {
    console.error(`[${request.kind} ${workflowId}] failed to start:`, err);
  });

  return { siteId, workflowId, site: { ...(site as Site), id: siteId } };
}
