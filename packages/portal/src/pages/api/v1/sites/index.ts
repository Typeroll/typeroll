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
import { personalSites } from '../../../../lib/personal-site-access';
import { createSite } from '../../../../lib/site-create';
import { parseNewSiteOptions, SiteIdTakenError, unknownFieldsError } from '../../../../lib/site-create-input';

/** Every field POST /api/v1/sites accepts; any other is refused with 400. */
const CREATE_SITE_FIELDS = ['name', 'id', 'domain', 'language'] as const;

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const allowed = ctx.personalUserId
    ? (await personalSites(ctx.personalUserId)).filter(entry => !ctx.personalAllowedOrgIds || ctx.personalAllowedOrgIds.includes(entry.ownerOrgId))
    : await listAllowedSites(ctx.tokenOrgId, ctx.tokenSiteId);
  return apiResponse(ctx, {
    // A site id is unique within an organization and not across them, and
    // listAllowedSites already knows which organization owns each entry. The
    // single-site route reports it and this one dropped it, so the cheapest
    // call for a caller to learn where it is pointed was the one that could
    // not answer. It matters most for a shared-in site, whose owner is not
    // the token's organization.
    sites: allowed.map(({ site, ownerOrgId, permission }) => ({
      permission,
      id: site.id,
      organization_id: ownerOrgId,
      name: site.name,
      domain: (site as { domain?: string }).domain,
      urls: publicUrlsFor(site),
    })),
  });
};

// POST /api/v1/sites — create + bootstrap a new site in the token's org.
// Body: { name, id?, domain?, language? }. `id` defaults to the slugified
// name; `language` (BCP 47, as in PATCH) defaults to "en".
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError('Invalid JSON body. Expected { name, id?, domain?, language? }.', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body. Expected { name, id?, domain?, language? }.', 400);
  const unknown = unknownFieldsError(body, CREATE_SITE_FIELDS);
  if (unknown) return apiError(unknown, 400, undefined, { code: 'unknown_field' });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const domain = typeof body.domain === 'string' ? body.domain.trim() || undefined : undefined;
  if (!name) return apiError('name is required.', 400);
  const options = parseNewSiteOptions(body);
  if (options.error !== undefined) return apiError(options.error, 400);

  let site: Awaited<ReturnType<typeof createSite>>['site'];
  try {
    ({ site } = await createSite({ orgId: ctx.tokenOrgId, name, domain, id: options.id, language: options.language }));
  } catch (error) {
    if (error instanceof SiteIdTakenError) return apiError(error.message, 409, undefined, { code: error.code });
    throw error;
  }
  return apiResponse(
    ctx,
    {
      site: {
        id: site.id,
        organization_id: ctx.tokenOrgId,
        name: site.name,
        domain: (site as { domain?: string }).domain,
        language: site.language ?? 'en',
        urls: publicUrlsFor(site),
      },
    },
    201,
    { name, domain, ...(options.id ? { id: options.id } : {}), ...(options.language ? { language: options.language } : {}) },
  );
};
