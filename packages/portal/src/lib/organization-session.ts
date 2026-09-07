import type { AstroCookies } from 'astro';
import { paths, type Member, type Organization, type MemberRole } from '@typeroll/shared';
import type { Session } from './auth';
import { getStore } from './datastore';

const COOKIE = 'typeroll_organization';
const validSegment = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && value !== '.' && value !== '..' && !/[/\\\x00-\x1f]/.test(value);
const indexPath = (userId: string) => `user_organizations/${encodeURIComponent(userId)}/organizations`;

export interface OrganizationChoice { id: string; name: string; role: MemberRole }

/** The index only discovers candidates; the member document grants access. */
export async function organizationMembership(userId: string, orgId: string): Promise<OrganizationChoice | null> {
  if (!validSegment(orgId) || !validSegment(userId)) return null;
  const store = getStore();
  const [org, member] = await Promise.all([
    store.getDoc<Organization>(paths.org(orgId)),
    store.getDoc<Member>(`${paths.members(orgId)}/${userId}`),
  ]);
  if (!org || !member || !['owner', 'admin', 'editor'].includes(member.role)) return null;
  return { id: orgId, name: org.name, role: member.role };
}

export async function rememberOrganization(userId: string, orgId: string): Promise<void> {
  if (await organizationMembership(userId, orgId)) {
    // Backup traversal visits real parent documents before their subcollections.
    await getStore().createDocIfMissing(`user_organizations/${encodeURIComponent(userId)}`, { schema_version: 1 });
    await getStore().createDocIfMissing(`${indexPath(userId)}/${orgId}`, { org_id: orgId });
  }
}

export async function listOrganizations(session: Session): Promise<OrganizationChoice[]> {
  // Existing accounts discover their original claim-based organization lazily.
  if (session.orgId) await rememberOrganization(session.userId, session.orgId);
  const entries = await getStore().listDocs(indexPath(session.userId));
  const choices = await Promise.all(entries.map((entry) => organizationMembership(session.userId, entry.id)));
  return choices.filter((choice): choice is OrganizationChoice => choice !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function selectOrganization(cookies: AstroCookies, userId: string, orgId: string): void {
  cookies.set(COOKIE, JSON.stringify({ userId, orgId }), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
    path: '/', maxAge: 14 * 24 * 60 * 60,
  });
  cookies.delete('typeroll_version', { path: '/' });
}

export function clearOrganization(cookies: AstroCookies): void {
  cookies.delete(COOKIE, { path: '/' });
  cookies.delete('typeroll_version', { path: '/' });
}

/** Selection is browser-local and untrusted, never an authorization claim. */
export async function resolveOrganizationSession(cookies: AstroCookies, session: Session): Promise<Session> {
  const raw = cookies.get(COOKIE)?.value;
  if (raw) {
    let selection;
    try { selection = JSON.parse(raw); } catch { selection = null; }
    if (selection?.userId === session.userId) {
      const membership = await organizationMembership(session.userId, selection.orgId);
      // Revoked selections become pending. Never fall back to a stale claim.
      return { ...session, orgId: membership?.id };
    }
  }
  if (session.orgId) {
    // Unmigrated single-org claims keep their existing compatibility behavior.
    // Once discovered, even the legacy default must honor membership removal.
    const indexed = await getStore().getDoc(`${indexPath(session.userId)}/${session.orgId}`);
    if (!indexed) return session;
    const membership = await organizationMembership(session.userId, session.orgId);
    if (membership) return session;
  }
  const choices = await listOrganizations(session);
  return { ...session, orgId: choices[0]?.id };
}
