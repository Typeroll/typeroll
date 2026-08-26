// GET /api/v1/sites/{siteId}
//
// Site metadata: id, name, domain. Doesn't include settings — those have
// their own endpoint at /v1/sites/{siteId}/settings.

import type { APIRoute } from 'astro';
import { apiError, requireApiKey, apiResponse } from '../../../../../lib/api-auth';
import { publicUrlsFor } from '../../../../../lib/site-public-urls';
import { getStore } from '../../../../../lib/datastore';
import { reprovisionFallbackSubdomain } from '../../../../../lib/hosting/site-provisioning';
import { paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

function project(site: Site & { id: string }, versionId: string): Record<string, unknown> {
  return {
    id: site.id,
    name: site.name,
    slug: (site as { slug?: string }).slug,
    domain: (site as { domain?: string }).domain,
    language: (site as { language?: string }).language,
    version_id: versionId,
    urls: publicUrlsFor(site),
  };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, project(ctx.site, ctx.versionId));
};

/**
 * Edit Site-level fields (separate from per-version settings). v1 allows
 * the agent to set name, slug, and domain. slug is uniqueness-checked
 * across the org so two sites can't claim the same fallback URL. Changing
 * slug does NOT re-provision the auto-attached CF Pages domain — that's
 * an ops task (the customer's existing fallback URL keeps working under
 * its old name until reprovisioning).
 */
export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Partial<Site> | null;
  if (!body) return apiError('Invalid JSON body');

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
    const lang = String(body.language).trim();
    if (lang && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) {
      return apiError('language must be a BCP-47 tag (e.g. "en", "sv", "en-GB")');
    }
    update.language = lang || undefined;
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

  if (Object.keys(update).length === 0) return apiError('No writable fields in body');

  // If slug changed, re-provision the CF Pages custom-domain + DNS so
  // the new `{slug}.{base}` URL actually serves the site. Best-effort:
  // CF errors don't block the slug update — the agent can re-run if it
  // wants, or fall back to the portal-attached subdomain.
  const reprovisioning: { ok: boolean; fallback?: string; cname?: string; error?: string } = { ok: true };
  if (update.slug && (ctx.site as { slug?: string }).slug !== update.slug) {
    try {
      const result = await reprovisionFallbackSubdomain({
        orgId: ctx.orgId,
        siteId: ctx.site.id,
        newSlug: String(update.slug),
      });
      if (result) {
        // Persist the new attached host on hosting_config so future
        // get_site reads point at the correct URL (publicUrlsFor checks
        // hosting_config.fallback_subdomain first). Also persist
        // pages_project: it's what the deploy adapter reads to know which
        // CF Pages project to push assets to. Sites bootstrapped outside
        // /api/sites/create (Firestore seed, manual provisioning) often
        // have it unset — without this the next trigger_deploy targets
        // the env-fallback project (or the stub adapter) instead of the
        // project the new subdomain was just attached to, and the URL
        // 522s because there are no assets at the destination.
        const existingConfig = (ctx.site as { hosting_config?: Record<string, unknown> }).hosting_config ?? {};
        (update as Record<string, unknown>).hosting_config = {
          ...existingConfig,
          fallback_subdomain: result.fallbackSubdomain,
          pages_project: (existingConfig.pages_project as string | undefined) ?? result.pagesProject,
        };
        reprovisioning.fallback = result.fallbackSubdomain;
        reprovisioning.cname = result.cnameTarget;
      }
    } catch (e) {
      reprovisioning.ok = false;
      reprovisioning.error = e instanceof Error ? e.message : String(e);
    }
  }

  const store = getStore();
  await store.setDoc(paths.site(ctx.orgId, ctx.site.id), { ...ctx.site, ...update });
  const fresh = await store.getDoc<Site>(paths.site(ctx.orgId, ctx.site.id));
  return apiResponse(ctx, {
    ...project((fresh ?? ctx.site) as Site & { id: string }, ctx.versionId),
    // Surface what the reprovisioning step did so the agent can tell the
    // customer "your URL is live after DNS propagates (~1-10 min)" or
    // can retry on its own if CF was down.
    //
    // ssl_ready_after is a conservative ISO timestamp (~5 min ahead) for
    // when the new fallback URL's TLS handshake is expected to succeed.
    // Agents wanting to verify the URL with a real HTTP call should
    // wait until at least that timestamp to avoid hitting cert errors
    // mid-provisioning.
    ...(reprovisioning.ok && reprovisioning.fallback
      ? {
          dns_note: `New fallback URL https://${reprovisioning.fallback} attached to CF Pages. SSL provisioning takes 1–10 minutes after DNS propagates. The previous fallback URL keeps working for now — manually deprovision it via the portal if you want to retire it.`,
          ssl_status: 'provisioning' as const,
          ssl_ready_after: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }
      : reprovisioning.ok
      ? {}
      : { dns_warning: `Slug saved, but CF re-provisioning failed: ${reprovisioning.error}. The URL won't resolve until you retry or attach manually.` }),
  }, 200, body);
};
