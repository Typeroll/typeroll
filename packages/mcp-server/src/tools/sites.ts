// Sites tools — discovery, Site-level identity edits and the site lifecycle
// (archive / restore). Each maps to a v1 route with the same permission
// check as the corresponding portal action.

import { z } from 'zod';
import { fail, ok, withErrorBoundary, type ToolDef } from './helpers.js';

/** Optional fields every site-creating tool accepts (POST /api/v1/sites and the create-and-* routes). */
export const newSiteFields = {
  id: z.string().optional().describe('Optional site id: 3-48 lowercase letters, digits and "-" (e.g. "acme-studio"). Used exactly; 409 site_id_taken when the organization has it. Default: the kebab-case name.'),
  language: z.string().optional().describe('Optional site content language as a BCP 47 tag (e.g. "en", "sv", "nl-BE"). Default "en". Drives <html lang>; change it later with update_site_settings.'),
};

/** The arguments that were given: an omitted optional field is not sent. */
export function definedFields(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

export const siteTools: ToolDef[] = [
  {
    name: 'read_organization_access',
    description: "Read the selected site's owning organization service access, trial and read/export deadlines, and recovery URL. Self-hosted installations are unrestricted by default. A trial expiry does not remove customer-hosted static sites. Use this on an organization_access error; do not retry a locked write.",
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'access'))),
  },
  {
    name: 'list_organizations', noSite: true,
    description: 'List organizations you belong to and your current role. Site work begins with list_sites and select_site; organization administration requires its explicit ID.',
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('organizations'))),
  },
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
      "Create + bootstrap a NEW site in your org. Blank (default): seeds default settings, a published Home page, and a published header/footer that link only to it, so it renders and can be published immediately. Requires an ORG-scoped key (a site-scoped key is bound to one existing site and can't mint new ones; you'll get a 403). Without `id` the site id is the kebab-case `name` (with a random suffix when taken); with `id` that exact id is used, or 409 site_id_taken. `language` is the site's BCP 47 content language (e.g. \"nl-BE\"; default: the template's language, else \"en\"), saved at creation so <html lang> is right from the first build. Pass `domain` to kick off the \"point your DNS\" flow (never written as a live domain). " +
      'START FROM A TEMPLATE with at most one of: `from_site_id` (another site of YOUR organization, optionally `from_site_version`; sites shared in from other organizations are refused with 404), `from_collection_entry` (a `package` entry of the organization collection, see list_collection_entries), `from_package_base64` or `from_package_url` (a whole-site .typeroll package; a package belongs to no organization, so a bought one works). ' +
      'Copied: pages (block and HTML pages and records of every content type), header, footer and global blocks, menus, styles (created with their ids, never mapped to "nearest" ones), block types, block and page templates, site fields with values, content types, forms (without their actions) and snippets, and media into the new site\'s own library (demo images stay marked for replacement; readiness lists them). Never copied: domains, publishing and hosting settings, API keys, shares, app installations (listed in warnings: install them on the new site), form actions and credentials, integrations, custom/tracking scripts, robots.txt, noindex switches, redirects, deploy history and revisions. A home page, header, footer and the primary/footer menus are created only where the template has none (started_from.defaults). ' +
      '`design`: "full" (default for a new site: element styles, colours, typography, scales, content widths and font roles), "styles" or "content" (the default look). Font files in the template are added only with `font_licence_confirmed: true` (ask the user whether the font licence allows use on the new site; never assume it), or left out with `fonts: false`; otherwise 400 font_licence_required. A package with an invalid signature is refused (package_signature_invalid); one that is not a whole site answers package_not_a_site. If the import fails the half-created site is removed again (site_create_failed, details.site_removed). ' +
      'Returns the new site\'s id, language + urls, and with a template `started_from` { kind, source, report, defaults, warnings } — show the warnings to the user. Use the id as `site_id`/`TYPEROLL_SITE_ID` for follow-up calls. After creating a blank site, run list_skills → read_skill tr-new-site to bootstrap the design.',
    noSite: true,
    inputSchema: {
      name: z.string().min(1).describe('Display name. Slugified into the site id unless `id` is given.'),
      ...newSiteFields,
      domain: z
        .string()
        .optional()
        .describe('Optional real hostname e.g. "example.com". Starts DNS setup; not set live until DNS verifies.'),
      from_site_id: z.string().optional().describe('Start as a copy of this site of your organization. REST body: `from: { site_id }`.'),
      from_site_version: z.string().optional().describe('With from_site_id: copy this version (branch) of the site instead of main. REST body: `from.version`.'),
      from_collection_entry: z.string().optional().describe('Start from this `package` entry of the organization collection. REST body: `from: { collection_entry }`.'),
      from_package_base64: z.string().optional().describe('Start from a whole-site .typeroll package, base64-encoded (at most 32 MB). REST body: `from: { package: { data_base64 } }`.'),
      from_package_url: z.string().optional().describe('Start from a whole-site .typeroll package downloaded from this https:// address (up to 200 MB). REST body: `from: { package: { source_url } }`.'),
      design: z.enum(['full', 'styles', 'content']).optional().describe('With a template: how much of its look to take (default "full"). REST body: `options.design`.'),
      fonts: z.boolean().optional().describe('With a template and design "full": take its font roles and font files (default true). REST body: `options.fonts`.'),
      font_licence_confirmed: z.boolean().optional().describe('true: the user confirmed the licence of the template\'s font files allows use on the new site. REST body: `options.font_licence_confirmed`.'),
    },
    handler: withErrorBoundary(async (args, { client }) => {
      const { from_site_id, from_site_version, from_collection_entry, from_package_base64, from_package_url, design, fonts, font_licence_confirmed, ...site } = args;
      const sources = [from_site_id, from_collection_entry, from_package_base64, from_package_url].filter(value => value !== undefined);
      if (sources.length > 1) return fail(new Error('Pass at most one of from_site_id, from_collection_entry, from_package_base64 and from_package_url.'));
      const options = definedFields({ design, fonts, font_licence_confirmed });
      if (!sources.length && (from_site_version !== undefined || Object.keys(options).length)) {
        return fail(new Error('from_site_version, design, fonts and font_licence_confirmed apply only when starting from a template (from_site_id, from_collection_entry or from_package_*).'));
      }
      const from = from_site_id !== undefined ? { site_id: from_site_id, ...(from_site_version !== undefined ? { version: from_site_version } : {}) }
        : from_collection_entry !== undefined ? { collection_entry: from_collection_entry }
          : from_package_base64 !== undefined ? { package: { data_base64: from_package_base64 } }
            : from_package_url !== undefined ? { package: { source_url: from_package_url } } : undefined;
      const res = await client.rootPost('sites', { ...definedFields(site), ...(from ? { from } : {}), ...(from && Object.keys(options).length ? { options } : {}) });
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
      'Read Analytics insights over the last 7, 30, or 90 days: traffic, AI-assistant referrals, and first-party conversion events grouped by event, destination, source, and campaign. Traffic is powered by Cloudflare Web Analytics; conversions come from validated attribution-funnel click events. The response carries a traffic `status`: "ok" with numbers, "no_data" for a linked site without traffic, or "app_disabled" / "not_configured" / "no_site_tag" / "connection_required" / "access_required" / "account_mismatch" / "provider_error" with a `reason` ({code, message, next_step, settings_url}). Traffic is read from the same Cloudflare account the beacon belongs to (`account`): the site\'s Hosting Group account for customer publishing, the installation\'s account otherwise. Conversion data can still be present when the traffic provider is unavailable.',
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
      'Probe the site\'s recorded fallback and live production origins and report indexing safety. Keeps X-Robots-Tag, HTML robots meta, and robots.txt crawl policy separate. expectation_reason identifies fallback_protection, platform_robots_blocked, sitewide_noindex or public_site. Customer publishing without a future website host intentionally blocks indexing even when sitewide_noindex is false; this is expected, not an error. Fallback URLs must expose the documented edge noindex header. Each target also records whose page was read: serving_publication (the X-Typeroll-Publication header, else /.well-known/typeroll/publication.json), serving_typeroll and provider_hint (a likely previous host named by a well-known header such as x-kinsta-cache). For customer publishing the current publication is expected; when another host or another publication answers, serving_typeroll is false, matches_expected is false and an issue explains it, because the robots findings then describe that other host. A previous host using Cloudflare for SaaS (for example Kinsta) outranks the customer\'s own DNS until the domain is removed from that host\'s dashboard. Use before launch and after changing domains or indexing settings.',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'indexing-diagnostics');
      return ok(res);
    }),
  },
  {
    name: 'update_site',
    description:
      'Edit Site-level fields: name (display), slug (a URL-stable identifier — kebab-case, 3-48 chars, unique across the org), domain (the customer\'s real hostname; pass "" to clear), language, and ai_scripts_enabled (the portal\'s "Allow AI to write block scripts" toggle; requires admin permission, as in the portal). For colors / fonts / contact info / tagline / staging_url use update_site_settings instead.',
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
