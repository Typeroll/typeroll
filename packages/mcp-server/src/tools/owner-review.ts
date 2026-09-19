import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

const versionQuery = (version?: string) => version ? { version } : undefined;
export const ownerReviewTools: ToolDef[] = [
  {
    name: 'read_owner_answers',
    description: 'Site administrator: read typed owner-writable answers and their current revision. Returns safe source kinds/times, never private actor identifiers.',
    inputSchema: { page_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async ({ version, ...input }, { client, siteId }) => ok(await client.post(siteId, 'owner-review', { ...input, action: 'answers' }, versionQuery(version)))),
  },
  {
    name: 'override_owner_answers',
    description: 'Explicit administrator correction of protected answers. Supply the current revision from read_owner_answers, changed fields, and the factual reason. Does not publish. Never use this tool to bypass an import or scraping conflict without explicit authorization.',
    inputSchema: { page_id: z.string(), base_revision: z.string(), fields: z.record(z.unknown()), reason: z.string().min(1), version: versionParam },
    handler: withErrorBoundary(async ({ version, ...input }, { client, siteId }) => ok(await client.post(siteId, 'owner-review', { ...input, action: 'override' }, versionQuery(version)))),
  },
  {
    name: 'list_owner_proposals',
    description: 'Site administrators: list isolated owner proposals and reviewer settings. Pending proposals are excluded from Pages, drafts and publication. Never exposes review tokens or owner identities.',
    inputSchema: { cursor: z.string().optional(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, 'owner-review', { cursor: args.cursor, ...versionQuery(args.version) }))),
  },
  {
    name: 'read_owner_proposal',
    description: 'Read the original before/after answers and review outcome. No changes or notifications are triggered.',
    inputSchema: { proposal_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'owner-review', { action: 'view', proposal_id: args.proposal_id }, versionQuery(args.version)))),
  },
  {
    name: 'configure_owner_review',
    description: 'Site administrators: configure the reviewer recipient, enabled state and token lifetime. A separately configured site email connector sends notifications. This action does not send email or publish.',
    inputSchema: { recipient: z.string().email(), enabled: z.boolean(), link_ttl_hours: z.number().int().min(1).max(168), version: versionParam },
    handler: withErrorBoundary(async ({ version, ...settings }, { client, siteId }) => ok(await client.post(siteId, 'owner-review', { action: 'settings', settings }, versionQuery(version)))),
  },
  {
    name: 'decide_owner_proposal',
    description: 'Explicit site-administrator editorial decision: approve, reject, or approve with adjustments. Requires current content/schema and a stable request_id for retries. First decision wins. Approval updates accepted CMS content, never deploys; reviewer adjustments retain separate provenance.',
    inputSchema: { proposal_id: z.string(), action: z.enum(['approve', 'reject']), request_id: z.string().min(16).max(100), adjustments: z.record(z.unknown()).optional(), version: versionParam },
    handler: withErrorBoundary(async ({ version, ...input }, { client, siteId }) => ok(await client.post(siteId, 'owner-review', input, versionQuery(version)))),
  },
  {
    name: 'retry_owner_review_notification',
    description: 'Explicitly send or retry the proposal notification. Maximum three attempts. Never retries an ambiguous in-flight delivery; an administrator must first record a recovery reason. Requires authorization to send this transactional notification.',
    inputSchema: { proposal_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'owner-review', { action: 'notify', proposal_id: args.proposal_id }, versionQuery(args.version)))),
  },
  {
    name: 'recover_owner_review_notification',
    description: 'Administrator recovery after investigating an interrupted notification. Record why retry is safe. Does not send email and does not reset the three-attempt bound.',
    inputSchema: { proposal_id: z.string(), reason: z.string().min(1), version: versionParam },
    handler: withErrorBoundary(async ({ version, ...input }, { client, siteId }) => ok(await client.post(siteId, 'owner-review', { ...input, action: 'recover-notification' }, versionQuery(version)))),
  },
  {
    name: 'revoke_owner_proposal',
    description: 'Revoke a pending proposal and its private review link. Accepted Page content remains unchanged.',
    inputSchema: { proposal_id: z.string(), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'owner-review', { action: 'revoke', proposal_id: args.proposal_id }, versionQuery(args.version)))),
  },
];
