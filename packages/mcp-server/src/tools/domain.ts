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
    description: 'Read the organization default domain. Requires an organization API key; site keys cannot access organization publishing settings.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('publishing/domains'))),
  },
  {
    name: 'set_organization_publishing_domains',
    description: 'Save the organization default domain used for demos and site versions. Requires an organization API key and the current settings revision. Does not modify DNS or replace an existing active domain.',
    inputSchema: { revision: z.string(), default_domain: z.string().nullable(), dns_mode: z.enum(['automatic', 'external']) },
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
