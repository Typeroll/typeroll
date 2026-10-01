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
      "Read the site's outgoing email connector (the provider form notifications send through): type, from, reply_to and config with secrets masked as { set: true }, plus every available provider with its field schema and whether the server can store secrets (crypto_configured). email is null when nothing is connected. Admin permission required.",
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'integrations/email'))),
  },
  {
    name: 'set_email_settings',
    description:
      "Connect or change the site's outgoing email provider, like Settings → Email & notifications in the portal. Read get_email_settings first for the provider field schema. Examples: postmark config { server_token, message_stream? }; smtp config { host, port?, secure?, user?, password? }. Secrets are encrypted server-side and never returned; omit a secret (or send the masked value) to keep the stored one. Then call send_test_email. Admin permission required.",
    inputSchema: {
      type: z.string().min(1).describe('Provider type from get_email_settings providers, e.g. "postmark" or "smtp".'),
      from: z.string().min(1).describe('Sender, e.g. "Acme <hello@acme.com>". Must be a sender the provider accepts.'),
      reply_to: z.string().optional().describe('Optional default Reply-To address.'),
      config: z.record(z.unknown()).optional().describe('Provider fields keyed by the field schema.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.put(siteId, 'integrations/email', {
      type: args.type,
      from: args.from,
      ...(args.reply_to !== undefined ? { reply_to: args.reply_to } : {}),
      config: args.config ?? {},
    }))),
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
