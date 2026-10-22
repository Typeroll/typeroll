// Optional Cloudflare capabilities of a hosting connection: what Analytics and
// redirect hosts can do through it, which granted OAuth scopes are missing,
// and the one step that adds them.
//
// A deployment chooses which optional scopes Connect Cloudflare requests
// (TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES, see cloudflare-config.ts).
// A connection made before a scope was enabled lacks it until an owner or
// admin approves one permission update. Each Hosting Group stores its own
// rotating OAuth grant, so a grant is never copied between connections or
// Organizations; one update instead renews every connection of this
// Organization that uses the same Cloudflare account, one after another.
//
// Granting a permission enables nothing by itself: Analytics stays off for
// every Site until it is enabled for that Site.

import { CLOUDFLARE_ANALYTICS_PROVISION_SCOPE, CLOUDFLARE_ANALYTICS_READ_SCOPE, CLOUDFLARE_REDIRECT_SCOPES, enabledCloudflareOptionalScopes } from './cloudflare-config';
import { getConnection, openCredentials, type Connection } from './connections';
import { getHostingGroup, listHostingGroups } from './hosting-groups';
import type { CloudflareStoredCredentials } from './cloudflare-oauth';

export type CloudflareCapabilityId = 'analytics_provisioning' | 'analytics_reports' | 'redirect_rules';
/**
 * available — the connection may do it.
 * approval_required — this deployment requests the missing scopes; one permission update adds them.
 * not_offered — this deployment does not request the missing scopes during Connect Cloudflare.
 * unknown — an API token connection; Cloudflare answers when it is used.
 * connection_required — the Hosting Group has no Cloudflare connection.
 */
export type CloudflareCapabilityState = 'available' | 'approval_required' | 'not_offered' | 'unknown' | 'connection_required';

export const CLOUDFLARE_CAPABILITIES: Record<CloudflareCapabilityId, { scopes: string[]; permission: string; token_permission: string; enables: string }> = {
  analytics_provisioning: {
    scopes: [CLOUDFLARE_ANALYTICS_PROVISION_SCOPE], permission: 'Account Settings (edit)', token_permission: 'Account → Account Settings → Edit',
    enables: 'Create a Site’s Cloudflare Web Analytics site when Analytics is enabled for that Site',
  },
  analytics_reports: {
    scopes: [CLOUDFLARE_ANALYTICS_READ_SCOPE], permission: 'Account Analytics (read)', token_permission: 'Account → Account Analytics → Read',
    enables: 'Read Web Analytics reports for Insights',
  },
  redirect_rules: {
    scopes: CLOUDFLARE_REDIRECT_SCOPES, permission: 'Dynamic URL Redirects (read and edit)', token_permission: 'Zone → Single Redirect → Edit',
    enables: 'Create the Single Redirect rule for redirect hosts such as www',
  },
};
const CAPABILITY_IDS = Object.keys(CLOUDFLARE_CAPABILITIES) as CloudflareCapabilityId[];

export interface CloudflareCapabilityStatus {
  capability: CloudflareCapabilityId;
  status: CloudflareCapabilityState;
  enables: string;
  required_scopes: string[];
  missing_scopes: string[];
  next_step: string | null;
}

export interface CloudflarePermissionUpdate {
  /** True when one approval adds scopes this deployment requests and the connection lacks. */
  required: boolean;
  missing_scopes: string[];
  /** Hosting Groups whose connections use the same Cloudflare account; the one approval renews all of them. */
  hosting_group_ids: string[];
  action: { kind: 'approve_update'; label: 'Approve update' } | null;
  next_step: string | null;
  /** Portal card where an organization owner or admin selects Approve update. */
  connect_url: string;
}

export interface CloudflarePermissionReport {
  hosting_group_id: string;
  hosting_group_name: string;
  connected: boolean;
  account_id: string | null;
  account_name: string | null;
  auth_method: 'oauth' | 'api_token' | null;
  /** Optional scopes this deployment requests with Connect Cloudflare. */
  requested_optional_scopes: string[];
  capabilities: CloudflareCapabilityStatus[];
  permission_update: CloudflarePermissionUpdate;
}

const PUBLISHING = '/app/settings/publishing';
/** Path of the Cloudflare card of a Hosting Group on the Publishing page. Default is the Organization's Cloudflare card. */
export const cloudflareCardPath = (groupId: string) => `${PUBLISHING}${groupId === 'default' ? '#cloudflare' : `#hosting-${groupId}`}`;
const absolute = (path: string) => `${(process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '')}${path}`;
const cardName = (groupId: string, name: string) => groupId === 'default' ? 'the Cloudflare account card' : `the Hosting Group “${name}” card`;
const unique = (values: string[]) => [...new Set(values)];

/** Granted OAuth scopes, null for API tokens, or 'unreadable'. */
function grantedScopes(orgId: string, groupId: string, connection: Connection): string[] | null | 'unreadable' {
  if (!connection.encrypted_credentials) return 'unreadable';
  try {
    const credentials = openCredentials<CloudflareStoredCredentials>(orgId, 'cloudflare', connection.encrypted_credentials, groupId);
    return credentials.oauth ? credentials.oauth.scope.split(/\s+/).filter(Boolean) : null;
  } catch { return 'unreadable'; }
}

/** The step that adds missing optional scopes to a connection: one approval on the Publishing card. */
export function permissionUpdateStep(groupId: string, groupName: string, missing: string[], groups: string[] = [groupId]): string {
  const permissions = unique(CAPABILITY_IDS.filter(id => CLOUDFLARE_CAPABILITIES[id].scopes.some(scope => missing.includes(scope)))
    .map(id => CLOUDFLARE_CAPABILITIES[id].permission));
  const covered = groups.length > 1 ? ` It also renews the other ${groups.length - 1} Hosting Group connection${groups.length > 2 ? 's' : ''} of this Organization that use${groups.length > 2 ? '' : 's'} the same Cloudflare account.` : '';
  return `In Account → Publishing, an organization owner or admin selects “Approve update” on ${cardName(groupId, groupName)} and approves ${permissions.join(', ') || missing.join(', ')} in Cloudflare once (scopes ${missing.join(', ')}). ` +
    `It covers every Site in the Hosting Group, current and future; the account, Sites and media stay connected.${covered} The approval enables Analytics for no Site: enable it per Site afterwards.`;
}

function notOfferedStep(capability: CloudflareCapabilityId, missing: string[]): string {
  const operator = `This Typeroll installation does not request ${missing.join(', ')} when connecting Cloudflare; its operator must allow the scope${missing.length > 1 ? 's' : ''} on the OAuth client and list ${missing.length > 1 ? 'them' : 'it'} in TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES.`;
  if (capability === 'redirect_rules') return `${operator} Until then set_publishing_domains returns the Single Redirect rule to create in Cloudflare (redirect_rule_required) and Typeroll verifies the public 301.`;
  return `${operator} Until then “Approve Analytics access” on a Site’s Analytics module requests it separately${capability === 'analytics_provisioning' ? ', or you can paste the token of a Web Analytics site created in that account as beacon_token' : ''}.`;
}

function capabilityStatus(id: CloudflareCapabilityId, granted: string[] | null | 'unreadable' | undefined, enabled: string[], groupName: string, groupId: string): CloudflareCapabilityStatus {
  const definition = CLOUDFLARE_CAPABILITIES[id];
  const base = { capability: id, enables: definition.enables, required_scopes: definition.scopes };
  if (granted === undefined) {
    return { ...base, status: 'connection_required', missing_scopes: definition.scopes,
      next_step: `Connect Cloudflare for ${groupId === 'default' ? 'the Organization' : `Hosting Group “${groupName}”`} in Account → Publishing.` };
  }
  if (granted === null) {
    return { ...base, status: 'unknown', missing_scopes: [],
      next_step: `This connection uses an API token; Cloudflare checks it when used. The token needs ${definition.token_permission}.` };
  }
  if (granted === 'unreadable') {
    return { ...base, status: 'unknown', missing_scopes: [], next_step: `The stored authorization cannot be read on this server. Reconnect Cloudflare on ${cardName(groupId, groupName)} in Account → Publishing.` };
  }
  const missing = definition.scopes.filter(scope => !granted.includes(scope));
  if (!missing.length) return { ...base, status: 'available', missing_scopes: [], next_step: null };
  if (missing.every(scope => enabled.includes(scope))) {
    return { ...base, status: 'approval_required', missing_scopes: missing, next_step: permissionUpdateStep(groupId, groupName, missing) };
  }
  return { ...base, status: 'not_offered', missing_scopes: missing, next_step: notOfferedStep(id, missing) };
}

/** Hosting Groups of this Organization whose connected OAuth connections use `accountId`, `first` first. */
export async function groupsSharingAccount(orgId: string, accountId: string, first: string): Promise<string[]> {
  const groups = await listHostingGroups(orgId);
  const matching = groups.filter(group => group.connection.status === 'connected' && group.connection.auth_method === 'oauth' && group.connection.cloudflare?.account_id === accountId).map(group => group.id);
  return [first, ...matching.filter(id => id !== first)].filter(id => matching.includes(id));
}

/** What a Hosting Group's Cloudflare connection can do, for API, MCP and the Publishing card. */
export async function cloudflarePermissionReport(orgId: string, groupId: string): Promise<CloudflarePermissionReport> {
  const group = await getHostingGroup(orgId, groupId);
  const connection = await getConnection(orgId, 'cloudflare', groupId);
  const connected = connection.status === 'connected' && Boolean(connection.cloudflare);
  const enabled = enabledCloudflareOptionalScopes();
  const granted = connected ? grantedScopes(orgId, groupId, connection) : undefined;
  const capabilities = CAPABILITY_IDS.map(id => capabilityStatus(id, granted, enabled, group.name, groupId));
  const missing = unique(capabilities.filter(item => item.status === 'approval_required').flatMap(item => item.missing_scopes));
  const groups = missing.length && connection.cloudflare ? await groupsSharingAccount(orgId, connection.cloudflare.account_id, groupId) : [groupId];
  return {
    hosting_group_id: groupId, hosting_group_name: group.name, connected,
    account_id: connected ? connection.cloudflare!.account_id : null, account_name: connected ? connection.cloudflare!.account_name : null,
    auth_method: connected ? connection.auth_method ?? 'api_token' : null,
    requested_optional_scopes: enabled, capabilities,
    permission_update: {
      required: missing.length > 0, missing_scopes: missing, hosting_group_ids: missing.length ? groups : [],
      action: missing.length ? { kind: 'approve_update', label: 'Approve update' } : null,
      next_step: missing.length ? permissionUpdateStep(groupId, group.name, missing, groups) : null,
      connect_url: absolute(cloudflareCardPath(groupId)),
    },
  };
}

/** Reports for every Hosting Group of the Organization, Default first. */
export async function cloudflarePermissionReports(orgId: string): Promise<CloudflarePermissionReport[]> {
  const groups = await listHostingGroups(orgId);
  return Promise.all(groups.map(group => cloudflarePermissionReport(orgId, group.id)));
}
