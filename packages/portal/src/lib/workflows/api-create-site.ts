// Public-API handlers for creating a site together with its first workflow:
// POST /api/v1/sites/create-and-migrate and POST /api/v1/sites/create-and-plan.
//
// Organization API keys only, like POST /api/v1/sites: a site-scoped key is
// bound to one existing site and has no authority to create sites. The new
// site lands under the key's organization.

import type { APIContext, APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../api-auth';
import { ConnectionError } from '../publishing/connections';
import { connectionFailure } from '../publishing/http';
import { publicUrlsFor } from '../site-public-urls';
import { createSiteWithWorkflow, parseSiteWorkflowRequest, SiteWorkflowInputError } from './create-site';

export function createSiteWithWorkflowRoute(kind: 'migration' | 'site_planning'): APIRoute {
  return async ({ request }) => {
    const guard = await requireAnyApiKey(request);
    if (!guard.ok) return guard.response;
    const ctx = guard.value;
    if (ctx.tokenSiteId !== null) {
      return apiError('Creating sites requires an org-scoped API key. This key is bound to a single site.', 403, ctx);
    }
    let body: unknown;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return apiError(kind === 'migration'
        ? 'Invalid JSON body. Expected { name, wp_url, helper_api_key? }.'
        : 'Invalid JSON body. Expected { name, business_description }.', 400, ctx);
    }
    try {
      const parsed = parseSiteWorkflowRequest(kind, body as Record<string, unknown>);
      const { site, workflowId } = await createSiteWithWorkflow({
        orgId: ctx.tokenOrgId,
        request: parsed,
        createdBy: `api-key:${ctx.keyPrefix}`,
      });
      return apiResponse(ctx, {
        site: { id: site.id, organization_id: ctx.tokenOrgId, name: site.name, urls: publicUrlsFor(site) },
        workflow: { id: workflowId, type: kind, status: 'running' },
      }, 201, kind === 'migration'
        ? { name: parsed.name, wp_url: (parsed as { wp_url: string }).wp_url }
        : { name: parsed.name });
    } catch (error) {
      if (error instanceof SiteWorkflowInputError) return apiError(error.message, 400, ctx);
      if (error instanceof ConnectionError) return connectionFailure(error);
      throw error;
    }
  };
}

/**
 * These static routes sit beside /api/v1/sites/{siteId}. Astro prefers the
 * static segment, so a site whose id happens to be "create-and-migrate" or
 * "create-and-plan" would lose its root route. Delegate the root's methods
 * with the segment as the site id so such a site stays reachable.
 */
export function asSiteRoot(siteId: string, handler: APIRoute): APIRoute {
  return (context: APIContext) => handler({
    ...context,
    request: context.request,
    url: context.url,
    params: { ...context.params, siteId },
  } as APIContext);
}
