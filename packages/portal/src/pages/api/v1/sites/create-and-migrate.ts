// POST /api/v1/sites/create-and-migrate — create a site in the key's
// organization and start a WordPress migration into it.
// Body: { name, wp_url, helper_api_key? }. Organization API key required.
// Returns 201 { site, workflow }; poll GET /api/v1/sites/{siteId}/workflows/{workflowId}.
// Requires verified organization import storage, like the New site form.

import { createSiteWithWorkflowRoute, asSiteRoot } from '../../../../lib/workflows/api-create-site';
import { GET as siteGet, PATCH as sitePatch } from './[siteId]/index';

export const POST = createSiteWithWorkflowRoute('migration');
export const GET = asSiteRoot('create-and-migrate', siteGet);
export const PATCH = asSiteRoot('create-and-migrate', sitePatch);
