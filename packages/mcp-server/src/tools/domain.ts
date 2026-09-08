// Custom-domain lifecycle tools. Wrap the four /api/v1/sites/{id}/domain/*
// routes so an agent can read, attach, poll, or remove a
// custom domain through MCP. Admin-only on the server side; site-scoped
// keys are implicitly admin, org-scoped keys forward the share's
// permission.
//
// State machine recap (see docs/domain-lifecycle-plan.md):
//
//   no domain   ──add_domain──▶  pending
//   pending     ──poll_domain──▶ pending | verified | failed
//   any state   ──remove_domain──▶ no domain
//
// `production_url` on the site response (list_sites / read_site) only
// reflects the custom domain when status === 'live'. Until then,
// agents should send users to the fallback URL.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const domainTools: ToolDef[] = [
  {
    name: 'list_hosting_groups',
    description: 'List organization Hosting Groups, site address bases and safe hosting connection status. Requires an organization API key. Media and GitHub remain shared.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/hosting-groups'))),
  },
  {
    name: 'save_hosting_group',
    description: 'Create a Hosting Group, or update its name, site address base and DNS mode using its current id and revision. Requires an organization API key. Does not move existing sites, media, or traffic. Connect the hosting account in Publishing.',
    inputSchema: { id: z.string().optional(), revision: z.string().optional(), name: z.string(), sites_domain: z.string().nullable(), dns_mode: z.enum(['automatic', 'external']) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/hosting-groups', args))),
  },
  {
    name: 'connect_hosting_group',
    description: 'Connect or disconnect an additional Hosting Group using a customer Cloudflare API token. Requires an organization API key and the current connection revision from list_hosting_groups. Default uses organization Publishing. No R2 access is required for the hosting token. Credentials are encrypted and never returned.',
    inputSchema: { action: z.enum(['connect', 'disconnect']), hosting_group_id: z.string(), revision: z.string(), account_id: z.string().optional(), api_token: z.string().optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/hosting-groups', args))),
  },
  {
    name: 'read_site_hosting_group',
    description: 'Read the selected site Hosting Group and eligible organization groups. Omitted legacy assignments resolve to Default.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'publishing/hosting-group'))),
  },
  {
    name: 'set_site_hosting_group',
    description: 'Select the Hosting Group for an unpublished site. Requires site admin permission and previous_group_id from read_site_hosting_group. Published sites or active builds require a hosting migration and are rejected.',
    inputSchema: { hosting_group_id: z.string(), previous_group_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.put(siteId, 'publishing/hosting-group', args))),
  },
  {
    name: 'list_organization_publishing_domains',
    description: 'List Cloudflare domains visible in the organization’s connected account, including activation, DNS hosting status and domain_access. Refresh this read to discover new domains; approval_required identifies missing OAuth consent without disconnecting the account. Requires an organization API key. Read only.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/zones'))),
  },
  {
    name: 'configure_organization_publishing_domains',
    description: 'Configure organization media and site subdomains using an active domain in the connected Cloudflare account. Attaches the media host to R2, creates its DNS record and queues media migration. Site/version addresses are created at deployment. Requires an organization API key and the current revision. Does not replace existing DNS destinations or existing media hosts. Read organization publishing domains afterward to check HTTPS activation.',
    inputSchema: { revision: z.string(), zone_id: z.string(), media_subdomain: z.string().describe('Short label, for example media.'), sites_subdomain: z.string().describe('Short label, for example sites.') },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('publishing/domains', args))),
  },
  {
    name: 'prepare_publishing_domain_change',
    description: 'Prepare future website and media hosts using only the last successfully published snapshot. Saved CMS changes stay unpublished. Requires the current domain revision. Poll read_publishing_domains for certificate and DNS requirements, then explicitly approve the verified cutover.',
    inputSchema: { revision: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'publishing/prepare', args))),
  },
  {
    name: 'read_organization_media_migration',
    description: 'Read progress and actionable failures while original media moves to the organization Cloudflare account. Requires an organization API key.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/media-migration'))),
  },
  {
    name: 'retry_organization_media_migration',
    description: 'Resume verified media migration after fixing account, R2 or domain setup. Source files remain readable; pointer changes require matching hashes. Requires an organization API key.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootPost('publishing/media-migration', {}))),
  },
  {
    name: 'read_publishing_readiness',
    description: 'Check required publishing connections and domains for the selected site. Returns actionable setup requirements. Editing and temporary previews remain available before publishing is configured.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'publishing'))),
  },
  {
    name: 'approve_publishing_domain_cutover',
    description: 'Approve switching website traffic to the verified frozen deployment. Read publishing domains first and review DNS requirements and certificate readiness. Existing traffic is preserved until validation succeeds. External DNS management remains the caller’s responsibility.',
    inputSchema: { revision: z.string(), candidate_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'publishing/cutover', args))),
  },
  {
    name: 'read_publishing_domains',
    description: 'Read the desired and active website and media hosts, retained media aliases, DNS management mode and domain configuration revision. Saving intent does not switch traffic.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'publishing/domains'))),
  },
  {
    name: 'set_publishing_domains',
    description: 'Save future website and media hosts before preparing a deployment. Requires the current revision from read_publishing_domains. This does not publish content or change traffic DNS. Choose external DNS when your agent manages Cloudflare independently.',
    inputSchema: {
      revision: z.string(), website_host: z.string().nullable(), media_host: z.string().nullable(),
      media_path_prefix: z.string().optional().describe('Empty on a separate media host; /media when using the website host.'),
      dns_mode: z.enum(['automatic', 'external']),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.put(siteId, 'publishing/domains', args))),
  },
  {
    name: 'read_organization_publishing_domains',
    description: 'Read the organization site address base, shared media host, live Cloudflare media-domain status and setup instructions. This read does not modify DNS. Requires an organization API key; site keys cannot access organization publishing settings.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/domains'))),
  },
  {
    name: 'set_organization_publishing_domains',
    description: 'Save separate organization hostnames: sites_domain for site and version addresses, media_host for shared media. Requires an organization API key and current settings revision. Automatic DNS mode queues media setup; external mode leaves DNS to you. Does not change nameservers or replace an existing media host.',
    inputSchema: { revision: z.string(), sites_domain: z.string().nullable().optional(), media_host: z.string().nullable().optional(),
      default_domain: z.string().nullable().optional().describe('Legacy shorthand for both hostnames; prefer sites_domain and media_host.'), dns_mode: z.enum(['automatic', 'external']) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPut('publishing/domains', args))),
  },
  {
    name: 'read_domain',
    description:
      "Read the current state of the site's custom domain. Returns " +
      '`{ hostname, status, dns_target, verified_at, failure_reason }` ' +
      "or `null` when no domain is attached. Status is one of 'pending' " +
      "(DNS not yet verified), 'verified' (DNS + cert OK, awaiting customer " +
      "activation), 'live' (production URL is now the custom domain), " +
      "'failed' (Cloudflare returned an error — see failure_reason).",
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'domain');
      return ok(res);
    }),
  },
  {
    name: 'add_domain',
    description:
      "Attach a custom domain to this site. The site MUST NOT already have " +
      "a domain set — remove the existing one first. Declaring the domain " +
      "makes it canonical immediately and queues a production deploy by " +
      "default; point DNS only after that deploy. Returns the CNAME target. " +
      "Use `poll_domain` to observe DNS/SSL verification. There is no separate " +
      "activation step in the current domain-first workflow.",
    inputSchema: {
      hostname: z
        .string()
        .describe('Hostname to attach, e.g. "www.example.com". Leading https:// and trailing slashes are stripped.'),
      prefer: z
        .enum(['apex', 'www'])
        .optional()
        .describe('Canonical host for an apex/www pair. Defaults to apex.'),
      auto_deploy: z
        .boolean()
        .optional()
        .describe('Default true. Publish the canonical/sitemap change before DNS cutover.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'domain', args);
      return ok(res);
    }),
  },
  {
    name: 'poll_domain',
    description:
      "Ask Cloudflare for the current state of the attached domain and " +
      "update the site doc accordingly. Idempotent — call after DNS " +
      "changes propagate. Returns the new state; status may have advanced " +
      "from 'pending' to 'verified' or 'failed'.",
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.post(siteId, 'domain/poll');
      return ok(res);
    }),
  },
  {
    name: 'activate_domain',
    description:
      "Legacy compatibility tool; new workflows should not call it. A declared " +
      "domain is already canonical and becomes visitable when DNS verifies. " +
      "For legacy records only, this changes the stored verified state to live. " +
      "Precondition: status must be 'verified' (or already 'live' — idempotent). " +
      "By default it also enqueues a production deploy; the " +
      "response includes `deploy.job_id` you can poll. Pass " +
      "`auto_deploy: false` to skip that compatibility deploy.",
    inputSchema: {
      auto_deploy: z
        .boolean()
        .optional()
        .describe('Default true. Enqueue a production deploy after activation so canonical URLs update.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'domain/activate', args);
      return ok(res);
    }),
  },
  {
    name: 'remove_domain',
    description:
      "Detach the custom domain from this site. Removes it from Cloudflare " +
      "Pages and clears the site doc. The fallback subdomain remains. " +
      "Use this when the customer wants to start over with a different " +
      "hostname or move the site to a different domain provider.",
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.del(siteId, 'domain');
      return ok(res);
    }),
  },
];
