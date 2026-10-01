// "Plan a new site with AI" on the New site page. The public-API equivalent is
// POST /api/v1/sites/create-and-plan; both use lib/workflows/create-site.

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
    parsed = parseSiteWorkflowRequest('site_planning', {
      name: String(form.get('name') ?? ''),
      business_description: String(form.get('business_description') ?? ''),
    });
  } catch (error) {
    if (error instanceof SiteWorkflowInputError) return new Response(error.message, { status: 400 });
    throw error;
  }

  const { siteId, workflowId } = await createSiteWithWorkflow({ orgId: session.orgId, request: parsed, createdBy: session.userId });
  return redirect(`/app/sites/${siteId}/workflows/${workflowId}`);
};
