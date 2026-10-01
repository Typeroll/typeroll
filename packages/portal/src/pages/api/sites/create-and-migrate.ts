// "Migrate from WordPress" on the New site page. The public-API equivalent is
// POST /api/v1/sites/create-and-migrate; both use lib/workflows/create-site.

import { connectionFailure } from '../../../lib/publishing/http';
import { ConnectionError } from '../../../lib/publishing/connections';
import type { APIRoute } from 'astro';
import { requireFullSession } from '../../../lib/access';
import { createSiteWithWorkflow, parseSiteWorkflowRequest, SiteWorkflowInputError } from '../../../lib/workflows/create-site';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const guard = await requireFullSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  const form = await request.formData();
  let parsed;
  try {
    parsed = parseSiteWorkflowRequest('migration', { name: String(form.get('name') ?? ''), wp_url: String(form.get('wp_url') ?? '') });
  } catch (error) {
    if (error instanceof SiteWorkflowInputError) return new Response(error.message, { status: 400 });
    throw error;
  }

  try {
    const { siteId, workflowId } = await createSiteWithWorkflow({ orgId: session.orgId, request: parsed, createdBy: session.userId });
    return redirect(`/app/sites/${siteId}/workflows/${workflowId}`);
  } catch (error) {
    if (error instanceof ConnectionError) return connectionFailure(error);
    throw error;
  }
};
