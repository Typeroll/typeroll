// Sites tools — discovery, Site-level identity edits and the site lifecycle
// (archive / restore). Each maps to a v1 route with the same permission
// check as the corresponding portal action.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const siteTools: ToolDef[] = [
  {
    name: 'list_sites', noSite: true,
    description: 'List accessible Sites without changing them. Use the returned IDs for site_id or your workspace binding. Results are paginated locally.',
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) },
    handler: withErrorBoundary(async (args, { client }) => {
      const response = await client.rootGet<{ sites: unknown[] }>('sites');
      const sites = response.sites ?? [];
      return ok({ sites: sites.slice(args.offset, args.offset + args.limit), total: sites.length, next_offset: args.offset + args.limit < sites.length ? args.offset + args.limit : null });
    }),
  },
  {
    name: 'create_site',
    description:
      "Create + bootstrap a NEW site in your org. Seeds default settings, a draft Home page, and a published header/footer so it renders immediately. Requires an ORG-scoped key (a site-scoped key is bound to one existing site and can't mint new ones; you'll get a 403). `name` drives a kebab-case site id; pass `domain` to kick off the \"point your DNS\" flow (never written as a live domain). Returns the new site's id + urls — use that id as `site_id`/`TYPEROLL_SITE_ID` for follow-up calls. After creating, run list_skills → read_skill tr-new-site to bootstrap the design.",
    noSite: true,
    inputSchema: {
      name: z.string().min(1).describe('Display name. Slugified into the site id.'),
      domain: z
        .string()
        .optional()
        .describe('Optional real hostname e.g. "example.com". Starts DNS setup; not set live until DNS verifies.'),
    },
    handler: withErrorBoundary(async (args, { client }) => {
      const res = await client.rootPost('sites', { name: args.name, domain: args.domain });
      return ok(res);
    }),
  },
  {
    name: 'get_site',
    description:
      'Read this site\'s metadata (id, name, slug, domain, language, ai_scripts_enabled, lifecycle {status: active|archived}, active version) + a urls object covering the production / fallback / preview_base / staging URLs. Useful as a first call to confirm the key is wired up and to learn what URLs the site is reachable at.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, '');
      return ok(res);
    }),
  },
  {
    name: 'get_site_capabilities',
    description:
      "Discover what the site-template renderer supports for this site. Returns a manifest of feature flags (blocks-mode, x-include, content-type routes, custom block scripts, dry-run deploys, etc.) plus template_capabilities_version + the core block type ids. Call this when you're about to do something structural (set route_template on a content type, switch a page to blocks-mode, install a custom block type) and want to feature-detect rather than guess. The manifest is platform-wide today; per-site custom templates land later.",
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'capabilities');
      return ok(res);
    }),
  },
  {
    name: 'get_site_insights',
    description:
      'Read Analytics insights over the last 7, 30, or 90 days: traffic, AI-assistant referrals, and first-party conversion events grouped by event, destination, source, and campaign. Traffic is powered by Cloudflare Web Analytics; conversions come from validated attribution-funnel click events. The response carries a traffic `status`: "ok" with numbers, or "app_disabled" / "not_configured" / "no_site_tag" / "no_data". Conversion data can still be present when the traffic provider is unavailable.',
    inputSchema: {
      days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional().describe('Look-back window in days (default 30).'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'insights', args.days ? { days: String(args.days) } : undefined);
      return ok(res);
    }),
  },
  {
    name: 'check_site_indexing',
    description:
      'Probe the site\'s recorded fallback and live production origins and report indexing safety. Keeps X-Robots-Tag, HTML robots meta, and robots.txt crawl policy separate; fallback URLs must expose the documented edge noindex header, while production follows sitewide_noindex. Use before launch and after changing domains or indexing settings.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'indexing-diagnostics');
      return ok(res);
    }),
  },
  {
    name: 'update_site',
    description:
      'Edit Site-level fields: name (display), slug (drives the {slug}.typeroll-fallback subdomain — kebab-case, 3-48 chars, unique across the org), domain (the customer\'s real hostname; pass "" to clear), language, and ai_scripts_enabled (the portal\'s "Allow AI to write block scripts" toggle; requires admin permission, as in the portal). For colors / fonts / contact info / tagline / staging_url use update_site_settings instead.',
    inputSchema: {
      name: z.string().min(1).optional(),
      slug: z.string().optional().describe('Kebab-case identifier, 3-48 chars [a-z0-9-]. Empty string clears.'),
      domain: z.string().optional().describe('Bare hostname e.g. "example.com". Empty string clears.'),
      language: z.string().optional().describe('Default content language as a BCP-47 tag (e.g. "en", "sv", "en-GB"). Drives <html lang> and the default for alt-text generation. Empty string clears.'),
      ai_scripts_enabled: z.boolean().optional().describe('"Allow AI to write block scripts": lets the in-portal chat assistant author block JavaScript for this site. API keys and MCP are not gated by it — they can always write block `script` and core/embed `js`. Requires admin permission.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.patch(siteId, '', args);
      return ok(res);
    }),
  },
  {
    name: 'archive_site',
    description:
      'Archive (retire) this site, the same action as Settings → Archive site in the portal. An archived site stays readable but refuses every write and publish until restored; the last published output keeps serving. Refused with 409 while a custom domain is still live or verified — move or remove the domain first. Requires an admin key of the organization that OWNS the site (a site-scoped key or the owner organization\'s org key); a key that reaches the site through a share is refused. Idempotent. Confirm with the user before calling.',
    inputSchema: {
      reason: z.string().max(500).optional().describe('Why the site is retired; shown in the portal.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'lifecycle', { action: 'archive', ...(args.reason ? { reason: args.reason } : {}) });
      return ok(res);
    }),
  },
  {
    name: 'restore_site',
    description:
      'Restore an archived site so it accepts writes and publishing again, the same action as Restore in the portal. Same permission as archive_site (owner-organization admin). Idempotent: restoring an active site succeeds without change.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.post(siteId, 'lifecycle', { action: 'restore' });
      return ok(res);
    }),
  },
];
