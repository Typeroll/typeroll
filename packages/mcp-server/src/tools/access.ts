// Access tools — API keys, cross-organization site sharing and organization
// invites. Each wraps the authenticated public API with the same permission
// checks as the portal: a key never mints a key or a grant that reaches
// further than it does.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

const keyId = z.string().regex(/^[a-f0-9]{12}$/).describe('Key id (the 12-hex prefix) from list_api_keys / list_organization_api_keys.');

export const accessTools: ToolDef[] = [
  {
    name: 'list_api_keys',
    description: 'List this Site\'s site-scoped API keys: id (prefix), name, created_at/created_by, last_used_at/last_used_ip and revoked_at. Never returns secrets or hashes. Any key that reaches the Site may list, as in Site settings → API keys.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'api-keys'))),
  },
  {
    name: 'revoke_api_key',
    description: 'Revoke one of this Site\'s API keys (admin permission on the Site). It stops authenticating immediately and stays listed as revoked for audit. Revoking the key this connection uses ends the connection. Organization keys are revoked with revoke_organization_api_key.',
    inputSchema: { key_id: keyId },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.del(siteId, `api-keys/${encodeURIComponent(args.key_id)}`))),
  },
  {
    name: 'list_site_shares',
    description: 'List the organizations this Site is shared with, including revoked shares for audit: id, shared_with_org_id, permission (read | write | admin), label, created_at, revoked_at. Admin permission on the Site, as in the portal.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'shares'))),
  },
  {
    name: 'share_site',
    description: 'Share this Site with another Organization, identified by org_id or org_slug (admin permission on the Site). permission is read, write (default) or admin; a share never exceeds admin, which the caller already holds. One active share per Organization: change it with update_site_share. Confirm the recipient with the user first — it gives every member of that Organization access.',
    inputSchema: {
      org_id: z.string().optional().describe('Recipient Organization id.'),
      org_slug: z.string().optional().describe('Recipient Organization slug, if the id is not known.'),
      permission: z.enum(['read', 'write', 'admin']).optional(),
      label: z.string().max(200).optional().describe('Optional note shown in the sharing list.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'shares', args))),
  },
  {
    name: 'update_site_share',
    description: 'Change the permission (read | write | admin) and/or label of an active share of this Site (admin permission on the Site). Takes effect on the recipient\'s next request.',
    inputSchema: {
      share_id: z.string().describe('Share id from list_site_shares.'),
      permission: z.enum(['read', 'write', 'admin']).optional(),
      label: z.string().max(200).optional(),
    },
    handler: withErrorBoundary(async ({ share_id, ...patch }, { client, siteId }) => ok(await client.patch(siteId, `shares/${encodeURIComponent(share_id)}`, patch))),
  },
  {
    name: 'revoke_site_share',
    description: 'Revoke a share of this Site (admin permission on the Site). The recipient Organization and its keys lose access immediately; the record stays listed as revoked.',
    inputSchema: { share_id: z.string().describe('Share id from list_site_shares.') },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.del(siteId, `shares/${encodeURIComponent(args.share_id)}`))),
  },
  {
    name: 'list_organization_api_keys',
    noSite: true,
    description: 'List the Organization\'s organization-scoped API keys (metadata only, never secrets). Requires an organization API key; site-scoped keys get 403. Site-scoped keys are listed per Site with list_api_keys.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('organization/api-keys'))),
  },
  {
    name: 'revoke_organization_api_key',
    noSite: true,
    description: 'Revoke an organization-scoped API key. Requires an organization API key. It stops authenticating immediately; revoking the key this connection uses ends the connection.',
    inputSchema: { key_id: keyId },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootDelete(`organization/api-keys/${encodeURIComponent(args.key_id)}`))),
  },
  {
    name: 'create_organization_invite',
    noSite: true,
    description: 'Create a signed invite link to the Organization (organization API key required). The invited person opens invite_url, signs in and joins as an editor; the link works until expires_at (ttl_days 1–30, default 7) and cannot be revoked early. Send it only to the person the user named.',
    inputSchema: { ttl_days: z.number().int().min(1).max(30).optional() },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('organization/invites', args))),
  },
];
