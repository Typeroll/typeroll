// GET /api/v1/sites/{siteId}
//
// Site metadata: id, name, domain. Doesn't include settings — those have
// their own endpoint at /v1/sites/{siteId}/settings.

import type { APIRoute } from 'astro';
import { apiError, requireApiKey, apiResponse } from '../../../../../lib/api-auth';
import { publicUrlsFor } from '../../../../../lib/site-public-urls';
import { getStore } from '../../../../../lib/datastore';
import { siteLifecycleState } from '../../../../../lib/site-lifecycle';
import { parseSiteLanguage, SITE_ID_RE } from '../../../../../lib/site-create-input';
import { paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';

const SLUG_RE = SITE_ID_RE;

function project(site: Site & { id: string }, versionId: string): Record<string, unknown> {
  return {
    id: site.id,
    name: site.name,
    slug: (site as { slug?: string }).slug,
    domain: (site as { domain?: string }).domain,
    language: (site as { language?: string }).language,
    // "Allow AI to write block scripts" — gates only the in-portal chat
    // assistant; API keys and MCP write block JS under their own authority.
    ai_scripts_enabled: site.ai_scripts_enabled === true,
    lifecycle: siteLifecycleState(site),
    version_id: versionId,
    urls: publicUrlsFor(site),
  };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, { ...project(ctx.site, ctx.versionId), organization_id: ctx.orgId });
};

/**
 * Edit Site-level fields (separate from per-version settings). v1 allows
 * the agent to set name, slug, domain, language and ai_scripts_enabled
 * ("Allow AI to write block scripts", admin only — the same check as the
 * portal's Settings → Custom code toggle). slug and domain are admin only
 * too: domain becomes the canonical URL of every build. slug is
 * uniqueness-checked across the org.
 */
export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Partial<Site> | null;
  if (!body) return apiError('Invalid JSON body');

  if ((body.slug !== undefined || body.domain !== undefined) && ctx.permission !== 'admin') {
    return apiError('Insufficient permission (admin required to change slug or domain)', 403, ctx);
  }

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return apiError('name cannot be empty');
    update.name = name;
  }
  if (body.domain !== undefined) {
    // Plain hostname (no scheme, no path). Empty string clears the field.
    const domain = String(body.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      return apiError('domain must be a bare hostname, e.g. "example.com"');
    }
    update.domain = domain || undefined;
  }
  if (body.language !== undefined) {
    const parsed = parseSiteLanguage(body.language);
    if (parsed.error !== undefined) return apiError(parsed.error);
    update.language = parsed.language || undefined;
  }
  if (body.slug !== undefined) {
    const slug = String(body.slug).trim().toLowerCase();
    if (slug && !SLUG_RE.test(slug)) {
      return apiError('slug must be 3-48 lowercase chars, kebab-case [a-z0-9-], starts + ends with alphanumeric');
    }
    // Uniqueness check across the org. Cheap because per-org site count
    // is bounded.
    if (slug) {
      const allSites = await getStore().listDocs<Site>(paths.sites(ctx.orgId));
      const clash = allSites.find((s) => s.id !== ctx.site.id && (s as { slug?: string }).slug === slug);
      if (clash) return apiError(`Slug "${slug}" is already used by another site in this organization`, 409);
    }
    update.slug = slug || undefined;
  }

  if (body.ai_scripts_enabled !== undefined) {
    if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403, ctx);
    if (typeof body.ai_scripts_enabled !== 'boolean') return apiError('ai_scripts_enabled must be boolean');
    update.ai_scripts_enabled = body.ai_scripts_enabled;
  }

  if (Object.keys(update).length === 0) return apiError('No writable fields in body');

  const store = getStore();
  await store.setDoc(paths.site(ctx.orgId, ctx.site.id), { ...ctx.site, ...update });
  const fresh = await store.getDoc<Site>(paths.site(ctx.orgId, ctx.site.id));
  return apiResponse(ctx, {
    ...project((fresh ?? ctx.site) as Site & { id: string }, ctx.versionId),
  }, 200, body);
};
