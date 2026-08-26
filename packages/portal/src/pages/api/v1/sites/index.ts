// GET /api/v1/sites
//
// Returns the site(s) the presented key can access. Site-scoped keys always
// see exactly one entry; org-scoped keys see every site the key reaches —
// sites owned by the issuing org plus sites shared into it via the cross-org
// share index. Agents use this as the uniform "discover what I can see"
// entry point (the MCP stdio server resolves its site binding from it).

import type { APIRoute } from 'astro';
import { requireAnyApiKey, listAllowedSites, apiResponse, apiError } from '../../../../lib/api-auth';
import { publicUrlsFor } from '../../../../lib/site-public-urls';
import { createSite } from '../../../../lib/site-create';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const allowed = await listAllowedSites(ctx.tokenOrgId, ctx.tokenSiteId);
  return apiResponse(ctx, {
    sites: allowed.map(({ site }) => ({
      id: site.id,
      name: site.name,
      domain: (site as { domain?: string }).domain,
      urls: publicUrlsFor(site),
    })),
  });
};

// POST /api/v1/sites — create + bootstrap a new site in the token's org.
//
// Org-scoped keys only: a site-scoped key is bound to one existing site and
// has no authority to mint new ones (its reach is a single siteId, never the
// org tree). The new site lands under the presenting token's org.
export const POST: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  if (ctx.tokenSiteId !== null) {
    return apiError('Creating sites requires an org-scoped API key. This key is bound to a single site.', 403);
  }

  let body: { name?: unknown; domain?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError('Invalid JSON body. Expected { name, domain? }.', 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const domain = typeof body.domain === 'string' ? body.domain.trim() || undefined : undefined;
  if (!name) return apiError('name is required.', 400);

  const { site } = await createSite({ orgId: ctx.tokenOrgId, name, domain });
  return apiResponse(
    ctx,
    {
      site: {
        id: site.id,
        name: site.name,
        domain: (site as { domain?: string }).domain,
        urls: publicUrlsFor(site),
      },
    },
    201,
    { name, domain },
  );
};
