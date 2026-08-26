// Shared "create a new site" logic.
//
// Extracted so both entry points run the exact same bootstrap:
//   - the cookie-auth form POST at /api/sites/create (the dashboard button)
//   - the bearer-auth REST POST at /api/v1/sites (agents / MCP `create_site`)
//
// Keep this the single source of truth for what a fresh site contains
// (settings + home page + header/footer partials + hosting provisioning).
// A new seed step belongs here, not duplicated in a route.

import { defaultSiteSettings, paths, slugify } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { getStore, generateDocId } from './datastore';
import { randomMediaId } from './media-keys';
import { defaultHeaderHtml, defaultFooterHtml } from './default-partials';
import { provisionSiteHosting } from './hosting/site-provisioning';
import { declareDomainAtCreation } from './site-domain';

export interface CreateSiteInput {
  /** Org that will own the new site. */
  orgId: string;
  /** Display name. Required; drives the slugified site id. */
  name: string;
  /** Optional real hostname. Goes through the domain-declaration flow (CF
   *  Pages register + "point your DNS"), never written as a bare live domain. */
  domain?: string;
}

export interface CreateSiteResult {
  siteId: string;
  site: Site & { id: string };
}

/**
 * Bootstrap a new site under `orgId`. Returns the new site id + the stored
 * doc (with `id` injected). Throws only on unexpected datastore failures —
 * CF provisioning and domain declaration are best-effort and never block
 * site creation (same posture as the original form route).
 */
export async function createSite(input: CreateSiteInput): Promise<CreateSiteResult> {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');
  const domain = input.domain?.trim() || undefined;

  const store = getStore();
  const siteId = slugify(name) || generateDocId();

  // Provision hosting BEFORE writing the site doc so the pages_project +
  // fallback_subdomain land in hosting_config from the start. No-op (stub
  // adapter) when CF credentials aren't configured.
  let hostingConfig: Site['hosting_config'] | undefined;
  try {
    const result = await provisionSiteHosting(input.orgId, siteId);
    if (result) {
      hostingConfig = {
        pages_project: result.pagesProject,
        fallback_subdomain: result.fallbackSubdomain ?? undefined,
      };
    }
  } catch (e) {
    console.error(`[create-site] CF provisioning failed for ${siteId}:`, e);
  }

  // NOTE: `domain` is deliberately NOT written here — a bare domain with no
  // lifecycle fields renders as "Live — DNS verified" (legacy-compat). The
  // typed domain goes through declareDomainAtCreation below.
  const site: Omit<Site, 'id'> = {
    name,
    // Anonymous, portable public media-key prefix (see lib/media-keys.ts) —
    // keeps org/site names out of public asset URLs and survives org moves.
    media_id: randomMediaId(),
    hosting_adapter: 'cloudflare',
    hosting_config: hostingConfig,
    staging_url: hostingConfig?.fallback_subdomain
      ? `https://${hostingConfig.fallback_subdomain}`
      : undefined,
    created_at: new Date().toISOString(),
  };
  await store.setDoc(paths.site(input.orgId, siteId), site);
  await store.setDoc(paths.settings(input.orgId, siteId), {
    ...defaultSiteSettings,
    site_name: name,
  });

  // Default home page in HTML mode.
  await store.setDoc(`${paths.pages(input.orgId, siteId)}/home`, {
    title: 'Home',
    slug: 'home',
    content_mode: 'html',
    status: 'draft',
    html_content: `<h1>Welcome to ${escapeHtml(name)}</h1><p>Your new site is ready to edit.</p>`,
    date_updated: new Date().toISOString(),
  });

  // Seed a published header + footer so the site renders from day one.
  await store.setDoc(paths.partial(input.orgId, siteId, 'header'), {
    name: 'Main header',
    kind: 'header',
    content_mode: 'html',
    status: 'published',
    html_content: defaultHeaderHtml(name),
  });
  await store.setDoc(paths.partial(input.orgId, siteId, 'footer'), {
    name: 'Main footer',
    kind: 'footer',
    content_mode: 'html',
    status: 'published',
    html_content: defaultFooterHtml(name),
  });

  if (domain) {
    await declareDomainAtCreation(input.orgId, siteId, domain);
  }

  return { siteId, site: { ...(site as Site), id: siteId } };
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
