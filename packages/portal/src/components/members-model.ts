// Pure helpers behind the organization's Members page: sorting members, the
// roles a row may offer, invite request bodies and readable API errors.
// OrganizationMembers.tsx stays thin around these.

import { ASSIGNABLE_ROLES, ORGANIZATION_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type MemberRole } from '@typeroll/shared';

export interface OrganizationMember {
  id: string;
  email: string;
  display_name?: string | null;
  role: MemberRole;
  joined_at: string | null;
}

export interface InviteSummary {
  id: string;
  state: 'active' | 'expired' | 'used' | 'revoked';
  role: MemberRole;
  email: string | null;
  created_by?: string;
  created_at: string;
  expires_at: string;
  max_uses: number;
  used_count: number;
}

export interface CreatedInvite { inviteId: string; inviteUrl: string; expiresAt: string; maxUses: number; email: string | null; role?: MemberRole }

export const membersApi = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/members`;
export const INVITES_API = '/api/orgs/invite';

const rank = (role: MemberRole) => ORGANIZATION_ROLES.indexOf(role);

/** Owners first, then administrators, builders and editors; by name or email within a role. */
export function sortMembers<T extends Pick<OrganizationMember, 'role' | 'email' | 'display_name'>>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => rank(a.role) - rank(b.role) || memberName(a).localeCompare(memberName(b)));
}

export const memberName = (member: Pick<OrganizationMember, 'email' | 'display_name'>) => member.display_name?.trim() || member.email;

/**
 * The roles a member's select offers: the assignable roles, plus Owner on an
 * owner's row or for an owner, who alone can make someone an owner.
 */
export function roleOptions(current: MemberRole, actor?: MemberRole): MemberRole[] {
  return current === 'owner' || actor === 'owner' ? ['owner', ...ASSIGNABLE_ROLES] : [...ASSIGNABLE_ROLES];
}

export const roleLabel = (role: MemberRole) => ROLE_LABELS[role] ?? role;
export const roleDescription = (role: MemberRole) => ROLE_DESCRIPTIONS[role] ?? '';

export const DEFAULT_INVITE_ROLE: MemberRole = 'editor';

export interface InviteDraft { role: MemberRole; email: string; ttlDays: number; maxUses: number }

export const initialInviteDraft = (): InviteDraft => ({ role: DEFAULT_INVITE_ROLE, email: '', ttlDays: 7, maxUses: 1 });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inviteProblems(draft: InviteDraft): Partial<Record<keyof InviteDraft, string>> {
  const problems: Partial<Record<keyof InviteDraft, string>> = {};
  if (!ASSIGNABLE_ROLES.includes(draft.role)) problems.role = 'Choose Administrator, Builder or Editor.';
  if (draft.email.trim() && !EMAIL.test(draft.email.trim())) problems.email = 'Enter an email address, or leave it empty.';
  if (!Number.isInteger(draft.ttlDays) || draft.ttlDays < 1 || draft.ttlDays > 30) problems.ttlDays = 'Between 1 and 30 days.';
  if (!Number.isInteger(draft.maxUses) || draft.maxUses < 1 || draft.maxUses > 50) problems.maxUses = 'Between 1 and 50 people.';
  return problems;
}

/** The POST /api/orgs/invite/generate body. */
export function inviteBody(draft: InviteDraft): Record<string, unknown> {
  return {
    role: draft.role, ttlDays: draft.ttlDays, max_uses: draft.maxUses,
    ...(draft.email.trim() ? { email: draft.email.trim().toLowerCase() } : {}),
  };
}

const STATE_LABELS: Record<InviteSummary['state'], string> = { active: 'Active', expired: 'Expired', used: 'Used', revoked: 'Revoked' };
export const inviteStateLabel = (state: InviteSummary['state']) => STATE_LABELS[state] ?? state;

/** A readable error from a members or invite response. */
export function memberApiError(body: unknown, status: number, action: string): string {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : '';
  if (code === 'last_owner') return 'An organization needs at least one owner. Make someone else an owner first.';
  if (typeof record.error === 'string' && record.error) return record.error;
  if (status === 403 || status === 404) return 'Only organization owners and administrators can manage members.';
  return `${action} failed (${status}).`;
}

/** "7 Nov 2026" in the reader's locale; the raw value when it isn't a date. */
export function shortDate(value: string | null | undefined, locale?: string): string {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(time));
}
