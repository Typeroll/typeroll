import { AsyncLocalStorage } from 'node:async_hooks';
import { paths, type Organization, type OrganizationServiceAccess } from '@typeroll/shared';

/** Optional host policy. Self-hosted installations have no policy by default. */
export interface OrganizationAccessPolicy {
  initial_days: number;
  read_days: number;
  contact_url: string;
  own_smtp: boolean;
}
export type AccessOperation = 'read' | 'write' | 'preview' | 'forms';
export interface OrganizationAccessView {
  state: 'unrestricted' | 'trial' | 'active' | 'read_only' | 'expired' | 'paused';
  reason: string | null;
  can_read: boolean;
  can_write: boolean;
  starts_at: string | null;
  ends_at: string | null;
  read_until: string | null;
  contact_url: string | null;
  own_smtp: boolean;
}
const DAY = 86_400_000;
const requestScope = new AsyncLocalStorage<{ request: Request; organizations: Map<string, Promise<Organization | null>> }>();
export const withAccessRequest = <T>(request: Request, work: () => Promise<T>): Promise<T> => requestScope.run({ request, organizations: new Map() }, work);
export const currentAccessRequest = () => requestScope.getStore()?.request;

export function organizationAccessPolicy(env = process.env): OrganizationAccessPolicy | null {
  const value = env.TYPEROLL_ORGANIZATION_ACCESS_POLICY;
  if (!value) return null;
  let policy: OrganizationAccessPolicy;
  try { policy = JSON.parse(value); } catch { throw new Error('Invalid organization access policy'); }
  if (!policy || !Number.isInteger(policy.initial_days) || policy.initial_days < 1 || policy.initial_days > 365
    || !Number.isInteger(policy.read_days) || policy.read_days < 1 || policy.read_days > 365
    || typeof policy.own_smtp !== 'boolean' || typeof policy.contact_url !== 'string'
    || !/^https:\/\/[^\s]+$/.test(policy.contact_url)) throw new Error('Invalid organization access policy');
  return policy;
}

export function initialOrganizationAccess(policy: OrganizationAccessPolicy | null, now: Date): OrganizationServiceAccess | undefined {
  if (!policy) return undefined;
  return { schema_version: 1, initial_period: { starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + policy.initial_days * DAY).toISOString(),
    read_until: new Date(now.getTime() + (policy.initial_days + policy.read_days) * DAY).toISOString() } };
}
const instant = (value: unknown): number => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

/** Pure deadline evaluator. Missing records grandfather existing organizations. */
export function evaluateOrganizationAccess(access: OrganizationServiceAccess | undefined, policy: OrganizationAccessPolicy | null, now = Date.now()): OrganizationAccessView {
  const view: OrganizationAccessView = { state: 'unrestricted', reason: null, can_read: true, can_write: true,
    starts_at: null, ends_at: null, read_until: null, contact_url: policy?.contact_url ?? null, own_smtp: false };
  if (!policy || !access) return view;
  const period = access.initial_period;
  const validPeriod = period && [period.starts_at, period.ends_at, period.read_until].every(v => Number.isFinite(instant(v)))
    && instant(period.starts_at) < instant(period.ends_at) && instant(period.ends_at) < instant(period.read_until);
  if (access.schema_version !== 1 || (period ? !validPeriod : !access.override)) return { ...view, state: 'expired', reason: 'organization_access_invalid', can_read: false, can_write: false };
  if (period) Object.assign(view, { starts_at: period.starts_at, ends_at: period.ends_at, read_until: period.read_until, own_smtp: policy.own_smtp });
  const override = access.override;
  if (override) {
    if (!['active', 'paused', 'cancelled'].includes(override.state)
      || (override.ends_at !== null && !Number.isFinite(instant(override.ends_at)))
      || (override.read_until !== null && !Number.isFinite(instant(override.read_until)))) {
      return { ...view, state: 'expired', reason: 'organization_access_invalid', can_read: false, can_write: false };
    }
    if (override.state === 'active' && (override.ends_at === null || now < instant(override.ends_at))) {
      return { ...view, state: 'active', ends_at: override.ends_at, read_until: override.read_until, own_smtp: false };
    }
    const canRead = override.read_until !== null && now < instant(override.read_until);
    return { ...view, state: override.state === 'paused' ? 'paused' : canRead ? 'read_only' : 'expired',
      reason: override.state === 'paused' ? 'organization_access_paused' : 'organization_access_ended',
      ends_at: override.ends_at, read_until: override.read_until, can_read: canRead, can_write: false };
  }
  if (!period) return { ...view, state: 'expired', reason: 'organization_access_invalid', can_read: false, can_write: false };
  if (now < instant(period.ends_at)) return { ...view, state: 'trial' };
  const canRead = now < instant(period.read_until);
  return { ...view, state: canRead ? 'read_only' : 'expired', reason: 'organization_trial_ended', can_read: canRead, can_write: false };
}

export async function readOrganizationAccess(orgId: string, now = Date.now()): Promise<OrganizationAccessView> {
  const policy = organizationAccessPolicy();
  if (!policy) return evaluateOrganizationAccess(undefined, null, now);
  const { getStore } = await import('./datastore');
  const cache = requestScope.getStore()?.organizations;
  let pending = cache?.get(orgId);
  if (!pending) { pending = getStore().getDoc<Organization>(paths.org(orgId)); cache?.set(orgId, pending); }
  const org = await pending;
  if (!org) return { ...evaluateOrganizationAccess(undefined, policy, now), state: 'expired', reason: 'organization_unavailable', can_read: false, can_write: false };
  return evaluateOrganizationAccess(org.service_access, policy, now);
}

export class OrganizationAccessError extends Error {
  readonly status = 403;
  constructor(readonly access: OrganizationAccessView, readonly operation: AccessOperation) {
    super(operation === 'forms' ? 'This form is temporarily unavailable. Please contact the website directly.'
      : access.can_read ? 'Your Cloud access period has ended. You can still read and export your content. Activate a subscription to continue editing and publishing.'
      : 'Cloud content access has ended. Contact support to restore access. Your published static websites remain online.');
  }
  response(): Response {
    return new Response(JSON.stringify({ error: this.message, code: this.access.reason ?? 'organization_access_ended',
      ...(this.operation !== 'forms' ? { access: this.access, recovery: ['organization_selection', 'subscription_contact', ...(this.access.can_read ? ['read', 'export'] : [])] } : {}) }),
    { status: this.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}
export async function assertOrganizationAccess(orgId: string, operation: AccessOperation): Promise<OrganizationAccessView> {
  const view = await readOrganizationAccess(orgId);
  if (!(operation === 'read' ? view.can_read : view.can_write)) throw new OrganizationAccessError(view, operation);
  return view;
}

/** Transport/auth/recovery stays reachable. Tool actions enforce their own bound site. */
export function requestAccessOperation(request: Request, sideEffectFree = false): AccessOperation | null {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (/^\/api\/(?:auth(?:\/|$)|mcp(?:\/|$)|account(?:\/|$))/.test(path)
    || ['/api/orgs', '/api/orgs/create', '/api/orgs/switch', '/api/orgs/invite/join', '/api/orgs/access', '/api/v1/access', '/api/v1/organizations'].includes(path)) return null;
  if (request.method === 'GET' && path === '/app/settings/access') return null;
  if (request.method === 'GET' && (/^\/api\/(?:v1\/)?sites$/.test(path) || /\/sites\/[^/]+\/access$/.test(path))) return null;
  if (request.method === 'DELETE' && /\/(?:api-keys|ai-connections)(?:\/|$)/.test(path)) return null;
  if (/\/(?:preview|preview-link|render)(?:\/|$)/.test(path)) return 'preview';
  if (sideEffectFree || ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || /\/pages\/batch-read$/.test(path)) return 'read';
  return 'write';
}
export async function organizationRequestRefusal(orgId: string, request = currentAccessRequest(), sideEffectFree = false): Promise<Response | null> {
  if (!request || !orgId || !organizationAccessPolicy()) return null;
  const operation = requestAccessOperation(request, sideEffectFree);
  if (!operation) return null;
  try { await assertOrganizationAccess(orgId, operation); return null; }
  catch (error) { if (error instanceof OrganizationAccessError) return error.response(); throw error; }
}

/** An upload accepted near expiry cannot grant fresh storage writes after expiry. */
export async function organizationUploadTtl(orgId: string, maximum = 300): Promise<number> {
  const access = await assertOrganizationAccess(orgId, 'write');
  const ttl = access.ends_at ? Math.min(maximum, Math.floor((instant(access.ends_at) - Date.now()) / 1000)) : maximum;
  if (ttl < 1) throw new OrganizationAccessError({ ...access, can_write: false, reason: 'organization_access_ended' }, 'write');
  return ttl;
}
