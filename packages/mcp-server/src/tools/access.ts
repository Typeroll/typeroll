// Access tools — API keys, cross-organization site sharing, organization
// invites and the Organization's own AI key for the portal assistant. Each
// wraps the authenticated public API with the same permission checks as the
// portal: a key never mints a key or a grant that reaches further than it
// does.

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef } from './helpers.js';

const keyId = z.string().regex(/^[a-f0-9]{12}$/).describe('Key id (the 12-hex prefix) from list_api_keys / list_organization_api_keys.');
const inviteId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).describe('Invite id from create_organization_invite or list_organization_invites.');

export const accessTools: ToolDef[] = [
  {
    name: 'list_api_keys',
    description: 'List this Site\'s site-scoped API keys: id (prefix), name, created_at/created_by, last_used_at/last_used_ip and revoked_at. Never returns secrets or hashes. Requires admin on the Site, as in Site settings → API keys.',
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
    description: 'Create a signed invite link to the Organization (organization API key required). The invited person opens invite_url, signs in and joins as an editor. The link works until expires_at (ttl_days 1–30, default 7) for max_uses people (1–50, default 1: single use); with email set, only a person signed in with that address can redeem it. Returns the invite id; list_organization_invites shows its state and revoke_organization_invite (or DELETE /api/v1/organization/invites/{id}) stops the link immediately. Send the link only to the person the user named.',
    inputSchema: {
      ttl_days: z.number().int().min(1).max(30).optional(),
      max_uses: z.number().int().min(1).max(50).optional().describe('How many people may redeem the link. Default 1 (single use).'),
      email: z.string().email().max(320).optional().describe('Bind the invite to this email address: only a person signed in with it can redeem the link.'),
    },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPost('organization/invites', args))),
  },
  {
    name: 'list_organization_invites',
    noSite: true,
    description: 'List the Organization\'s invites, newest first, without their links: id, state (active | used | expired | revoked), role, email (when bound), created_by, created_at, expires_at, max_uses, used_count and revoked_at. Requires an organization API key; site-scoped keys get 403.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('organization/invites'))),
  },
  {
    name: 'revoke_organization_invite',
    noSite: true,
    description: 'Revoke an Organization invite by id (from create_organization_invite or list_organization_invites). Its link stops working immediately; people who already joined keep their membership. Requires an organization API key.',
    inputSchema: { invite_id: inviteId },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootDelete(`organization/invites/${encodeURIComponent(args.invite_id)}`))),
  },
  {
    name: 'read_organization_ai_settings',
    noSite: true,
    description: 'Read the Organization\'s built-in AI assistant settings: whether its own Anthropic API key is set (last four characters, verified_at, who set it and when — never the key), site_access ({ mode: "all" | "selected", site_ids }) and every Site of the Organization with ai_enabled. The portal AI chat appears only on Sites with ai_enabled. This setting never limits MCP or the API: you can edit every Site you have access to. Requires an organization API key, or a personal connection in an Organization where the person is an owner or admin.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootGet('organization/ai'))),
  },
  {
    name: 'set_organization_ai_key',
    noSite: true,
    description: 'Add or replace the Organization\'s own Anthropic API key for the portal\'s built-in AI assistant. Typeroll checks the key with Anthropic before saving: a rejected key returns 422 ai_key_rejected and an unreachable Anthropic 502 ai_key_unverified, and nothing is stored. The key is stored encrypted and never returned. A first key enables no Sites; replacing a key keeps the Site choice. Only call this with a key the user gave you for this purpose and their explicit go-ahead; prefer that an owner or admin enters it in the portal (Organization settings → AI assistant) so it does not pass through this conversation. Never repeat the key back. Requires an organization API key.',
    inputSchema: { api_key: z.string().min(20).max(512).describe('The Anthropic API key (starts with sk-ant-).') },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPut('organization/ai/key', { api_key: args.api_key }))),
  },
  {
    name: 'remove_organization_ai_key',
    noSite: true,
    description: 'Remove the Organization\'s Anthropic API key. The portal AI chat disappears from every Site and the Site choice starts over; MCP and the API are unaffected. Requires an organization API key and the user\'s explicit go-ahead.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client }) => ok(await client.rootDelete('organization/ai/key'))),
  },
  {
    name: 'set_organization_ai_site_access',
    noSite: true,
    description: 'Choose which of the Organization\'s own Sites show the portal AI chat: mode "all" (every Site, including Sites created later) or mode "selected" with site_ids from read_organization_ai_settings (an empty list turns it off everywhere). A Site shared in from another Organization follows that owner\'s setting. Needs a key first (409 ai_key_required). Requires an organization API key.',
    inputSchema: {
      mode: z.enum(['all', 'selected']),
      site_ids: z.array(z.string()).max(1000).optional().describe('Required when mode is "selected".'),
    },
    handler: withErrorBoundary(async (args, { client }) => ok(await client.rootPut('organization/ai/site-access',
      args.mode === 'all' ? { mode: 'all' } : { mode: 'selected', site_ids: args.site_ids ?? [] }))),
  },
];
