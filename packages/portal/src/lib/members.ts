// Organization members: who belongs to an organization, with which role, and
// changing or removing them. One path for the portal's cookie routes, the v1
// API (organization keys and personal connections) and MCP.
//
// Rules:
//   - Owners and administrators manage members (roleCanManageOrganization).
//     An organization API key acts as an administrator, as it does for
//     invites.
//   - Only an owner makes someone an owner, or changes or removes an owner.
//   - The last owner can be neither demoted nor removed (not even by
//     themselves): an organization always keeps someone who can manage it.
//
// A change to an owner is guarded on another owner's document staying as it
// was read, in the same write, so two owners demoting each other at the same
// moment cannot leave the organization without one.

import {
  ORGANIZATION_ROLES, isOrganizationRole, paths, roleCanManageOrganization,
  type Member, type MemberRole,
} from '@typeroll/shared';
import { getStore, type ConditionalEffect } from './datastore';

export class MemberError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

/** Who is acting: a person in the organization, or an organization API key (acts as admin). */
export interface MemberActor {
  /** The person's user id; absent for an API key. */
  userId?: string;
  role: MemberRole;
}

export interface MemberSummary {
  id: string;
  email: string;
  display_name: string | null;
  role: MemberRole;
  joined_at: string | null;
}

const MEMBER_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const memberPath = (orgId: string, userId: string) => `${paths.members(orgId)}/${userId}`;
const organizationIndex = (userId: string, orgId: string) => `user_organizations/${encodeURIComponent(userId)}/organizations/${orgId}`;

function summary(member: Member & { id: string }): MemberSummary {
  return {
    id: member.id,
    email: member.email ?? '',
    display_name: member.display_name ?? null,
    role: isOrganizationRole(member.role) ? member.role : 'editor',
    joined_at: member.joined_at ?? null,
  };
}

const ROLE_ORDER: Record<MemberRole, number> = { owner: 0, admin: 1, builder: 2, editor: 3 };

/** The organization's members, owners first, then by email. */
export async function listMembers(orgId: string): Promise<MemberSummary[]> {
  const members = await getStore().listDocs<Member>(paths.members(orgId));
  return members.filter(member => isOrganizationRole(member.role)).map(summary)
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.email.localeCompare(b.email) || a.id.localeCompare(b.id));
}

/** The acting person's member role, or null when they are not a member. */
export async function memberRole(orgId: string, userId: string): Promise<MemberRole | null> {
  const member = await getStore().getDoc<Member>(memberPath(orgId, userId));
  return member && isOrganizationRole(member.role) ? member.role : null;
}

function assertManager(actor: MemberActor): void {
  if (!roleCanManageOrganization(actor.role)) throw new MemberError('Only organization owners and administrators can manage members', 403, 'member_permission');
}

async function readTarget(orgId: string, memberId: string): Promise<Member & { id: string }> {
  if (typeof memberId !== 'string' || !MEMBER_ID.test(memberId)) throw new MemberError('Member not found', 404, 'member_not_found');
  const member = await getStore().getDoc<Member>(memberPath(orgId, memberId));
  if (!member || !isOrganizationRole(member.role)) throw new MemberError('Member not found', 404, 'member_not_found');
  return member;
}

/** A guard that another owner stays an owner, or a refusal when the target is the last one. */
async function anotherOwner(orgId: string, memberId: string, refusal: string): Promise<ConditionalEffect> {
  const others = (await getStore().listDocs<Member>(paths.members(orgId))).filter(member => member.id !== memberId && member.role === 'owner');
  if (!others.length) throw new MemberError(refusal, 409, 'last_owner');
  const other = others.sort((a, b) => a.id.localeCompare(b.id))[0]!;
  return { path: memberPath(orgId, other.id), data: {}, expected: other as unknown as Record<string, unknown>, guardOnly: true };
}

/** Change a member's role. */
export async function updateMemberRole(orgId: string, actor: MemberActor, memberId: string, role: unknown): Promise<MemberSummary> {
  assertManager(actor);
  if (!isOrganizationRole(role)) throw new MemberError(`role must be one of ${ORGANIZATION_ROLES.join(', ')}`, 400, 'member_role_invalid');
  const target = await readTarget(orgId, memberId);
  if (target.role === role) return summary(target);
  if ((role === 'owner' || target.role === 'owner') && actor.role !== 'owner') {
    throw new MemberError('Only an owner can make someone an owner or change an owner\'s role', 403, 'owner_required');
  }
  const guards = target.role === 'owner' ? [await anotherOwner(orgId, memberId, 'The organization needs an owner: make someone else an owner first')] : [];
  const { id: _id, ...record } = target;
  void _id;
  const next = { ...record, role };
  if (!await getStore().compareAndReplaceDoc(memberPath(orgId, memberId), target as unknown as Record<string, unknown>, next, guards)) {
    throw new MemberError('The members changed while saving; try again', 409, 'member_conflict');
  }
  return summary({ ...next, id: memberId } as Member & { id: string });
}

/** Remove a member from the organization. Their invites and API keys are unaffected; their access ends at once. */
export async function removeMember(orgId: string, actor: MemberActor, memberId: string): Promise<{ removed: true; id: string }> {
  const target = await readTarget(orgId, memberId);
  const self = actor.userId !== undefined && actor.userId === memberId;
  // Anyone may leave (the last owner excepted); removing someone else needs a manager.
  if (!self) assertManager(actor);
  if (target.role === 'owner' && !self && actor.role !== 'owner') {
    throw new MemberError('Only an owner can remove an owner', 403, 'owner_required');
  }
  const guards = target.role === 'owner' ? [await anotherOwner(orgId, memberId, 'The last owner cannot be removed: make someone else an owner first')] : [];
  const store = getStore();
  if (!await store.compareAndReplaceDoc(memberPath(orgId, memberId), target as unknown as Record<string, unknown>, {}, guards)) {
    throw new MemberError('The members changed while saving; try again', 409, 'member_conflict');
  }
  await store.deleteDoc(memberPath(orgId, memberId));
  // The index only discovers organizations; membership was the member document.
  await store.deleteDoc(organizationIndex(memberId, orgId)).catch(() => {});
  return { removed: true, id: memberId };
}

/** A refused member request as `{ status, body }`, or null for an unexpected error. */
export function memberFailureBody(error: unknown): { status: number; body: { error: string; code: string } } | null {
  return error instanceof MemberError ? { status: error.status, body: { error: error.message, code: error.code } } : null;
}
