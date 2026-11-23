// Site email — the same settings as the portal's Settings → Email & notifications, with the
// same admin permission: the outgoing connector that form notifications send
// through (with a test send), and incoming email forwarding for host-approved
// addresses. Secrets are write-only: reads return { set: true } instead.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

export const emailTools: ToolDef[] = [
  {
    name: 'get_email_settings',
    description:
      "Read the site's selected outgoing account, campaign sending limits, available organization account and provider fields. Secrets are masked; shared organization credentials are never returned. Campaign limits are per site across its apps and exclude transactional mail. Admin permission required.",
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'integrations/email'))),
  },
  {
    name: 'set_email_settings',
    description:
      "Connect or change the site's outgoing email provider, like Settings → Email & notifications in the portal. Read get_email_settings first for the provider field schema. Examples: postmark config { server_token, message_stream? }; smtp config { host, port?, secure?, user?, password? }. Secrets are encrypted server-side and never returned; omit a secret (or send the masked value) to keep the stored one. Then call send_test_email. Admin permission required.",
    inputSchema: {
      type: z.string().min(1).optional().describe('Provider type when configuring this site’s own account.'),
      from: z.string().min(1).optional().describe('Sender when configuring this site’s own account.'),
      source: z.enum(['site', 'organization', 'none']).optional().describe('Organization requires a current grant from its owner. Selecting it references the shared account without copying credentials.'),
      bulk_email: z.object({ daily_limit: z.number().int().min(0).max(10000).optional(), minimum_interval_minutes: z.number().int().min(1).max(1440).optional() }).optional().describe('Site campaign allowance and pacing. UTC day; 0 disables campaigns. Transactional mail does not consume this allowance.'),
      reply_to: z.string().optional().describe('Optional default Reply-To address.'),
      config: z.record(z.string(), z.unknown()).optional().describe('Provider fields keyed by the field schema.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.put(siteId, 'integrations/email', {
      ...(args.type !== undefined ? { type: args.type, config: args.config ?? {} } : {}),
      ...(args.from !== undefined ? { from: args.from } : {}),
      ...(args.source !== undefined ? { source: args.source } : {}),
      ...(args.bulk_email !== undefined ? { bulk_email: args.bulk_email } : {}),
      ...(args.reply_to !== undefined ? { reply_to: args.reply_to } : {}),
    }))),
  },
  {
    name: 'get_organization_email_settings', noSite: true,
    description: 'Read the selected Organization’s shared email account with secrets masked, its exact revision and the owned Sites allowed to use it. Only a current Organization owner, through a personal connection or an owner-issued organization API key, can manage this account. Site keys are refused.',
    inputSchema: {}, handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('organization/email'))),
  },
  {
    name: 'set_organization_email_settings', noSite: true,
    description: 'Configure the Organization’s shared email account or its explicit Site grants. Read get_organization_email_settings first and pass its expected_revision. Prefer entering secrets in the portal; never repeat a secret. Omitted fields preserve the account or grants; a new account allows no Sites by default. Sites must still select the organization account themselves and retain their own campaign budgets. Owner authority is required.',
    inputSchema: { expected_revision: z.string().regex(/^[a-f0-9]{64}$/), type: z.string().optional(), from: z.string().optional(), reply_to: z.string().optional(), config: z.record(z.string(), z.unknown()).optional(), allowed_site_ids: z.array(z.string()).max(1000).optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPut('organization/email', args))),
  },
  {
    name: 'remove_organization_email_settings', noSite: true,
    description: 'Disconnect the Organization’s shared mail account and withdraw all Site grants. Sites using it stop sending through that account; they do not silently fall back to another account. Requires the current expected_revision, Organization owner authority and the user’s approval for this disconnection.',
    inputSchema: { expected_revision: z.string().regex(/^[a-f0-9]{64}$/) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootDelete('organization/email', args))),
  },
  {
    name: 'send_organization_test_email', noSite: true,
    description: 'Send one test through the stored Organization mail account, only when the user requested this test and recipient. Requires Organization owner authority. It does not start a campaign or grant Site access.',
    inputSchema: { to: z.string().min(3) },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('organization/email', args))),
  },
  {
    name: 'delete_email_settings',
    description:
      "Disconnect the site's outgoing email provider and delete its stored credentials. Form email notifications stop being sent until a provider is connected again; submissions are still stored. Admin permission required.",
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.del(siteId, 'integrations/email'))),
  },
  {
    name: 'send_test_email',
    description:
      'Send a test email through the stored email connector to check it works, like "Send test" in the portal. Save the connector with set_email_settings first. Admin permission required.',
    inputSchema: {
      to: z.string().min(3).describe('Recipient address for the test message.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'integrations/email/test', { to: args.to }))),
  },
  {
    name: 'get_incoming_email_settings',
    description:
      "Read the site's incoming email forwarding: host-approved routes (alias → forwarding target), each route's current revision, whether forwarding is enabled and the last message receipt with delivery status. Routes are created by the hosting administrator; an empty list means none is approved yet. Admin permission required.",
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'delivery/inbound'))),
  },
  {
    name: 'set_incoming_email_forwarding',
    description:
      'Enable or disable forwarding for one host-approved incoming email route, like Settings → Email & notifications in the portal. Pass the route_id and the current revision from get_incoming_email_settings; a changed route (409) must be read again and reviewed first. This cannot create aliases or change targets. Enable, verify with a real test message, and only then change the site\'s Reply-To. Admin permission required.',
    inputSchema: {
      route_id: z.string().min(1),
      revision: z.string().min(1).describe('The revision returned by get_incoming_email_settings for this route.'),
      enabled: z.boolean(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.put(siteId, 'delivery/inbound', {
      route_id: args.route_id,
      revision: args.revision,
      enabled: args.enabled,
    }))),
  },
  {
    name: 'read_incoming_email_receipt',
    description:
      'Read one incoming email receipt (status such as forwarded, held or blocked, its reason and the forwarded delivery status) by the receipt_id shown in get_incoming_email_settings. Contains no subject, sender or body. Admin permission required.',
    inputSchema: {
      receipt_id: z.string().regex(/^[a-f0-9]{64}$/),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, `delivery/inbound/${encodeURIComponent(args.receipt_id)}`))),
  },
];
