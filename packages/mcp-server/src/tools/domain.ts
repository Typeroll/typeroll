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
