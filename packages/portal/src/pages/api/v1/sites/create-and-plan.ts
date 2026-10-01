// POST /api/v1/sites/create-and-plan — create a site in the key's
// organization and start AI site planning from a business description.
// Body: { name, business_description }. Organization API key required.
// Returns 201 { site, workflow }; poll GET /api/v1/sites/{siteId}/workflows/{workflowId}
// and approve its review gate with POST .../approve.

import { createSiteWithWorkflowRoute, asSiteRoot } from '../../../../lib/workflows/api-create-site';
import { GET as siteGet, PATCH as sitePatch } from './[siteId]/index';

export const POST = createSiteWithWorkflowRoute('site_planning');
export const GET = asSiteRoot('create-and-plan', siteGet);
export const PATCH = asSiteRoot('create-and-plan', sitePatch);
