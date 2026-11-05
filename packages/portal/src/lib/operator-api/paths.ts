// The document families the operator may touch, derived from what the
// operator actually reads and writes. Everything else is refused, including
// the portal's identity tables (`auth_*`, reachable only through the people
// methods), store internals (`site_owners`, `_outbox`, `scheduled_work`) and
// organization credentials (`organizations/{org}/connections`, …).

import { OperatorApiError } from './contract';

export type Access = 'read' | 'write' | 'delete';

const S = '[A-Za-z0-9][A-Za-z0-9_.%-]{0,255}';
const rx = (source: string) => new RegExp(`^${source.replaceAll('S', S)}$`);
// `S` in a pattern is one path segment; no collection name below contains a capital S.
const doc = (pattern: string, ...access: Access[]) => ({ pattern: rx(pattern), access: new Set(access) });

const DOCUMENTS = [
  // Organization and subscription administration.
  doc('organizations/S', 'read', 'write'),
  doc('organizations/S/members/S', 'read', 'write', 'delete'),
  // Site rename and retirement; temporary site-scoped keys for app actions.
  doc('organizations/S/sites/S', 'read', 'write', 'delete'),
  doc('organizations/S/sites/S/api_keys/S', 'read', 'write', 'delete'),
  doc('organizations/S/sites/S(?:/S/S)+', 'read', 'delete'),
  // App registry, release review and private-site grants.
  doc('organizations/S/extensions/S', 'read', 'write'),
  doc('organizations/S/extensions/S/versions/S', 'read', 'write'),
  doc('extension_catalog/S', 'read', 'write'),
  // Host approval of a native admin page; written only by platform operators.
  doc('extension_admin_approvals/S', 'read', 'write'),
  // Operator records.
  doc('platform_operation_locks/S', 'read', 'write', 'delete'),
  doc('platform_audit/S', 'read', 'write'),
  // Membership discovery markers and credential/share indexes.
  doc('user_organizations/S', 'read', 'write'),
  doc('user_organizations/S/organizations/S', 'read', 'write'),
  doc('api_key_lookup/S', 'read', 'write', 'delete'),
  doc('org_share_index/S/shares/S', 'read', 'delete'),
  // The operator's own Better Auth tables (its database lives here).
  doc('operator_auth_[a-z][a-z0-9_]*/S', 'read', 'write', 'delete'),
];

const COLLECTIONS = [
  'organizations',
  'organizations/S/members',
  'organizations/S/sites',
  'organizations/S/sites/S(?:/S/S)*/S',
  'organizations/S/extensions/S/versions',
  'extension_catalog',
  'extension_admin_approvals',
  'operator_auth_[a-z][a-z0-9_]*',
].map(rx);

export function documentAccess(path: string): ReadonlySet<Access> {
  if (typeof path !== 'string' || path.length > 1024) return new Set();
  return DOCUMENTS.find(rule => rule.pattern.test(path))?.access ?? new Set();
}

export function assertDocument(path: string, access: Access): void {
  if (!documentAccess(path).has(access)) throw new OperatorApiError('forbidden_path', `${access} is not allowed for ${String(path).slice(0, 200)}`);
}

export function assertCollection(path: string): void {
  if (typeof path !== 'string' || path.length > 1024 || !COLLECTIONS.some(pattern => pattern.test(path))) {
    throw new OperatorApiError('forbidden_path', `list is not allowed for ${String(path).slice(0, 200)}`);
  }
}

/**
 * The atomic scope of a document: its site, its organization, or global.
 * Matches the store's object boundaries (lib/store/sharded-store.ts), so a
 * commit whose reads share one scope can be conditional on every backend.
 */
export function commitScope(path: string): string {
  const site = /^organizations\/([^/]+)\/sites\/([^/]+)(?:\/|$)/.exec(path);
  if (site) return `site:${site[1]}/${site[2]}`;
  const org = /^organizations\/([^/]+)(?:\/|$)/.exec(path);
  if (org) return `org:${org[1]}`;
  return 'global';
}
