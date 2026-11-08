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
import { loadNewSiteSource, parseNewSiteFrom, parseNewSiteImportOptions } from '../../../../lib/packages/new-site-source';
import { apiNewSiteFrom } from '../../../../lib/packages/new-site-requests';
import { packageApiFailure } from '../../../../lib/packages/package-api';
import { MAX_INLINE_PACKAGE_BYTES } from '../../../../lib/packages/package-requests';
import { apiUpdatedBy } from '../../../../lib/snippet-write';

/** Every field POST /api/v1/sites accepts; any other is refused with 400. */
const CREATE_SITE_FIELDS = ['name', 'id', 'domain', 'language', 'from', 'options'] as const;

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
// Body: { name, id?, domain?, language?, from?, options? }. `id` defaults to
// the slugified name; `language` (BCP 47, as in PATCH) defaults to the
// source's language, else "en".
//
// `from` starts the site from a whole-site package or another site instead
// of the blank starter: { site_id, version? } (a site of the token's own
// organization; shared-in sites are refused), { collection_entry } (a
// `package` entry of the organization collection) or { package:
// { data_base64 | source_url } }. `options`: { design?: "full" (default) |
// "styles" | "content", fonts?, font_licence_confirmed? }. The answer adds
// `started_from` { kind, source, report, defaults, warnings }. A failed
// import removes the half-created site again (code site_create_failed or
// the import's own code, details.site_removed).
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

  const length = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > Math.ceil(MAX_INLINE_PACKAGE_BYTES / 3) * 4 + 1024 * 1024) {
    return apiError(`A package sent as data_base64 may be at most ${MAX_INLINE_PACKAGE_BYTES / 1024 / 1024} MB; send a larger one as source_url`, 413, undefined, { code: 'package_too_large' });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError('Invalid JSON body. Expected { name, id?, domain?, language?, from?, options? }.', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body. Expected { name, id?, domain?, language?, from?, options? }.', 400);
  const unknown = unknownFieldsError(body, CREATE_SITE_FIELDS);
  if (unknown) return apiError(unknown, 400, undefined, { code: 'unknown_field' });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const domain = typeof body.domain === 'string' ? body.domain.trim() || undefined : undefined;
  if (!name) return apiError('name is required.', 400);
  const options = parseNewSiteOptions(body);
  if (options.error !== undefined) return apiError(options.error, 400);

  let site: Awaited<ReturnType<typeof createSite>>['site'];
  let startedFrom: Awaited<ReturnType<typeof createSite>>['started_from'];
  let fromAudit: Record<string, unknown> | undefined;
  try {
    let start: Parameters<typeof createSite>[0]['from'];
    if (body.from !== undefined && body.from !== null) {
      const importOptions = parseNewSiteImportOptions(body.options);
      const from = await apiNewSiteFrom(ctx.tokenOrgId, await parseNewSiteFrom(body.from, { allowPackage: true }));
      fromAudit = from.kind === 'site' ? { site_id: from.site_id, ...(from.version ? { version: from.version } : {}) } : from.kind === 'collection_entry' ? { collection_entry: from.entry_id } : { package: true };
      start = { source: await loadNewSiteSource(ctx.tokenOrgId, from, importOptions), options: importOptions };
      fromAudit.options = importOptions;
    } else if (body.options !== undefined) {
      return apiError('options apply only with from.', 400, undefined, { code: 'site_source_invalid' });
    }
    ({ site, started_from: startedFrom } = await createSite({
      orgId: ctx.tokenOrgId, name, domain, id: options.id, language: options.language, ...(start ? { from: start } : {}), actor: apiUpdatedBy(ctx.keyPrefix),
    }));
  } catch (error) {
    if (error instanceof SiteIdTakenError) return apiError(error.message, 409, undefined, { code: error.code });
    return packageApiFailure(error, ctx);
  }
  return apiResponse(
    ctx,
    {
      // `id` at the top level too: the documented "201 with the new site's id".
      id: site.id,
      site: {
        id: site.id,
        organization_id: ctx.tokenOrgId,
        name: site.name,
        domain: (site as { domain?: string }).domain,
        language: site.language ?? 'en',
        urls: publicUrlsFor(site),
      },
      ...(startedFrom ? { started_from: startedFrom } : {}),
    },
    201,
    { name, domain, ...(options.id ? { id: options.id } : {}), ...(options.language ? { language: options.language } : {}), ...(fromAudit ? { from: fromAudit } : {}) },
  );
};
