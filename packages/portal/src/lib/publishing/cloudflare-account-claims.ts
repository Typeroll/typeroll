// Shared Cloudflare accounts: which Typeroll Organizations (and which of their
// Hosting Groups) use one Cloudflare account, and which Organization owns each
// Cloudflare resource Core creates there.
//
// Several Organizations may use one Cloudflare account, for example one owner
// with several companies. Joining an account another Organization already uses
// requires a person who is an owner or admin of at least one Organization that
// uses it: that proves common control. Nobody learns anything about an
// Organization they do not administer.
//
// Sites stay separate inside a shared account. Every resource name Core
// generates is derived from the Organization (and Site) identity, and Core
// records the owning Organization of every bucket, Pages project and Worker
// before using it. An operation on a resource recorded for another
// Organization is refused, whatever its name.
//
// Claim documents written before sharing contain only `{ org_id }`. They are
// read as that Organization's membership, derived from its connections that
// currently use the account, and upgraded on the next write.

import { createHash, randomUUID } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { organizationMembership } from '../organization-session';
import { ConnectionError, connectionPath, type Connection } from './connections';
import { cloudflareBlocker } from './cloudflare-diagnosis';

export interface CloudflareAccountMember {
  org_id: string;
  /** Hosting Groups of this Organization whose connection uses the account. */
  hosting_groups: string[];
  joined_at: string | null;
  joined_by: string | null;
}
export interface CloudflareAccountClaim {
  schema: 2;
  provider: 'cloudflare';
  account_id: string;
  revision: string;
  members: CloudflareAccountMember[];
  /** First member, kept for Core instances that still read the single-owner shape during a rolling update. */
  org_id: string | null;
  /** Organization of a claim written before sharing; its buckets were recorded as its own when the claim was upgraded. */
  legacy_org_id: string | null;
  /** Set while the last member leaves; joining waits until the document is gone. */
  releasing_until: number | null;
}
type StoredClaim = Partial<CloudflareAccountClaim> & { id: string };
export interface CloudflareOrganizationRef { id: string; name: string }
export type CloudflareAccountAccessState = 'member' | 'first' | 'returning' | 'join' | 'refused';
export interface CloudflareAccountAccess {
  /**
   * member — this Organization already uses the account. first — no other Organization uses it.
   * returning — this Organization's saved connection already names the account (its sites are there).
   * join — another Organization uses it and this person administers one of them. refused — otherwise.
   */
  state: CloudflareAccountAccessState;
  /** Other Organizations using the account that this person administers. Never others. */
  shared_with: CloudflareOrganizationRef[];
  /** Joining needs an explicit confirmation that names `shared_with`. */
  confirmation_required: boolean;
}
export interface Actor { orgId: string; userId: string }

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const RELEASE_MS = 30_000;

function accountSegment(accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new ConnectionError('Invalid Cloudflare account identity');
  return accountId;
}
export const cloudflareClaimPath = (accountId: string) => `publishing_account_claims/cloudflare-${accountSegment(accountId)}`;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Hosting Groups of an Organization whose connection currently uses this account. */
async function connectedGroups(orgId: string, accountId: string): Promise<string[]> {
  const store = getStore();
  const groups = await store.listDocs<{ id: string }>(`${paths.org(orgId)}/hosting_groups`);
  const ids = ['default', ...groups.map(group => group.id).filter(id => id !== 'default')];
  const found: string[] = [];
  for (const id of ids) {
    const connection = await store.getDoc<Connection>(connectionPath(orgId, 'cloudflare', id)).catch(() => null);
    if (connection?.status === 'connected' && connection.cloudflare?.account_id === accountId) found.push(id);
  }
  return found;
}

/** Whether any connection of this Organization, connected or not, is saved for this account. */
async function savedForAccount(orgId: string, accountId: string): Promise<boolean> {
  const store = getStore();
  const groups = await store.listDocs<{ id: string }>(`${paths.org(orgId)}/hosting_groups`);
  for (const id of ['default', ...groups.map(group => group.id).filter(id => id !== 'default')]) {
    const connection = await store.getDoc<Connection>(connectionPath(orgId, 'cloudflare', id)).catch(() => null);
    if (connection?.cloudflare?.account_id === accountId) return true;
  }
  return false;
}

function validMembers(value: unknown): CloudflareAccountMember[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CloudflareAccountMember => Boolean(item) && typeof item.org_id === 'string' && Array.isArray(item.hosting_groups))
    .map(item => ({ org_id: item.org_id, hosting_groups: item.hosting_groups.filter((group: unknown): group is string => typeof group === 'string'),
      joined_at: item.joined_at ?? null, joined_by: item.joined_by ?? null }));
}

/** The members of a stored claim, reading the single-owner shape as its Organization's current use. */
async function membersOf(stored: StoredClaim | null, accountId: string, now = Date.now()): Promise<CloudflareAccountMember[]> {
  if (!stored) return [];
  if (stored.schema === 2) {
    const members = validMembers(stored.members);
    return members.length || !(stored.releasing_until && stored.releasing_until > now) ? members : [];
  }
  if (typeof stored.org_id !== 'string') return [];
  const groups = await connectedGroups(stored.org_id, accountId);
  return groups.length ? [{ org_id: stored.org_id, hosting_groups: groups, joined_at: null, joined_by: null }] : [];
}

/** Organizations that use the account now. Server-side only: never return this list to a person. */
export async function cloudflareAccountMembers(accountId: string): Promise<CloudflareAccountMember[]> {
  return membersOf(await getStore().getDoc<StoredClaim>(cloudflareClaimPath(accountId)), accountId);
}

/** True when another Organization uses the account too. */
export async function isSharedCloudflareAccount(orgId: string, accountId: string): Promise<boolean> {
  return (await cloudflareAccountMembers(accountId)).some(member => member.org_id !== orgId);
}

async function administered(userId: string, orgIds: string[]): Promise<CloudflareOrganizationRef[]> {
  const result: CloudflareOrganizationRef[] = [];
  for (const orgId of orgIds) {
    const membership = await organizationMembership(userId, orgId);
    if (membership && (membership.role === 'owner' || membership.role === 'admin')) result.push({ id: membership.id, name: membership.name });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function decide(actor: Actor, members: CloudflareAccountMember[], shared: CloudflareOrganizationRef[], returning: boolean): CloudflareAccountAccess {
  const others = members.filter(member => member.org_id !== actor.orgId);
  if (members.some(member => member.org_id === actor.orgId)) return { state: 'member', shared_with: shared, confirmation_required: false };
  if (!others.length) return { state: 'first', shared_with: [], confirmation_required: false };
  if (returning) return { state: 'returning', shared_with: shared, confirmation_required: shared.length > 0 };
  if (shared.length) return { state: 'join', shared_with: shared, confirmation_required: true };
  return { state: 'refused', shared_with: [], confirmation_required: false };
}

async function accessFor(actor: Actor, accountId: string, members: CloudflareAccountMember[]): Promise<CloudflareAccountAccess> {
  const others = members.filter(member => member.org_id !== actor.orgId).map(member => member.org_id);
  const shared = others.length ? await administered(actor.userId, others) : [];
  const returning = others.length > 0 && !members.some(member => member.org_id === actor.orgId) && await savedForAccount(actor.orgId, accountId);
  return decide(actor, members, shared, returning);
}

/**
 * May this person connect the account for this Organization, and must they confirm sharing it?
 * The person's roles are read from the member documents of each Organization now, never from a session claim.
 */
export async function cloudflareAccountAccess(actor: Actor, accountId: string): Promise<CloudflareAccountAccess> {
  return accessFor(actor, accountId, await cloudflareAccountMembers(accountId));
}

/** The refusal shown to a person who administers no Organization using the account. Names none of them. */
export function sharedAccountRefusal(actor: Actor, account?: { id: string; name: string }) {
  const message = cloudflareBlocker('claimed_by_other_organization', account ? { account } : {}).message;
  // An API key acts for no person, so it cannot prove common control.
  return new ConnectionError(actor.userId.startsWith('api-key:') ? `${message} An API key cannot confirm this: connect the account in Typeroll → Publishing while signed in.` : message,
    409, 'claimed_by_other_organization');
}

export function sharedAccountConfirmation(access: CloudflareAccountAccess, accountName?: string) {
  const names = access.shared_with.map(org => org.name).join(', ');
  return new ConnectionError(`${accountName || 'This Cloudflare account'} is also used by: ${names}. Sites stay separate. Confirm to use it for this Organization as well.`, 409,
    'shared_account_confirmation_required', { shared_with: access.shared_with.map(org => org.name) });
}

/**
 * Record that this Organization's Hosting Group uses the account. Verifies, at write time, that the person may
 * join it (see cloudflareAccountAccess) and that a required confirmation was given. Idempotent.
 */
export async function joinCloudflareAccount(actor: Actor, accountId: string, groupId: string, options: { confirmed?: boolean; accountName?: string } = {}): Promise<CloudflareAccountAccess & { added: boolean }> {
  const account = options.accountName ? { id: accountId, name: options.accountName } : undefined;
  const store = getStore(), path = cloudflareClaimPath(accountId);
  for (let attempt = 0; attempt < 50; attempt++) {
    const stored = await store.getDoc<StoredClaim>(path);
    if (stored?.schema === 2 && !validMembers(stored.members).length && stored.releasing_until && stored.releasing_until > Date.now()) { await sleep(200); continue; }
    const members = await membersOf(stored, accountId);
    const access = await accessFor(actor, accountId, members);
    if (access.state === 'refused') throw sharedAccountRefusal(actor, account);
    if (access.confirmation_required && !options.confirmed) throw sharedAccountConfirmation(access, options.accountName);
    const own = members.find(member => member.org_id === actor.orgId);
    const next = own
      ? members.map(member => member === own ? { ...member, hosting_groups: [...new Set([...member.hosting_groups, groupId])] } : member)
      : [...members, { org_id: actor.orgId, hosting_groups: [groupId], joined_at: new Date().toISOString(), joined_by: actor.userId }];
    const legacy = stored && stored.schema !== 2 ? stored.org_id ?? null : stored?.legacy_org_id ?? null;
    if (stored?.schema === 2 && own?.hosting_groups.includes(groupId)) return { ...access, added: false };
    // Before another Organization joins, record the buckets every current member's connection names as its own.
    const recorded = new Set([...(legacy && stored?.schema !== 2 ? [legacy] : []), ...(own ? [] : members.map(member => member.org_id))]);
    for (const orgId of recorded) await recordConnectionBuckets(orgId, accountId);
    const data = claimData(accountId, next, legacy);
    const written = stored ? await store.compareAndUpdateDoc<StoredClaim>(path, current => sameVersion(current, stored), data)
      : await store.createDocIfMissing(path, data);
    if (written) return { ...access, added: !own?.hosting_groups.includes(groupId) };
  }
  throw new ConnectionError('The Cloudflare account is being updated by another request. Try again.', 409, 'revision_conflict');
}

/**
 * Remove a Hosting Group's use of the account after its connection was disconnected. The Organization stays a
 * member while another of its Hosting Groups uses the account; the claim is deleted only when nobody uses it.
 */
export async function leaveCloudflareAccount(orgId: string, accountId: string, groupId: string): Promise<void> {
  const store = getStore(), path = cloudflareClaimPath(accountId);
  for (let attempt = 0; attempt < 50; attempt++) {
    const stored = await store.getDoc<StoredClaim>(path);
    if (!stored) return;
    const members = await membersOf(stored, accountId);
    const next = members.map(member => member.org_id === orgId ? { ...member, hosting_groups: member.hosting_groups.filter(group => group !== groupId) } : member)
      .filter(member => member.hosting_groups.length > 0);
    const legacy = stored.schema !== 2 ? stored.org_id ?? null : stored.legacy_org_id ?? null;
    if (stored.schema === 2 && next.length === members.length && next.every((member, index) => member.hosting_groups.length === members[index].hosting_groups.length)) return;
    if (legacy && stored.schema !== 2) await recordConnectionBuckets(legacy, accountId);
    if (!next.length) {
      const releasing = await store.compareAndUpdateDoc<StoredClaim>(path, current => sameVersion(current, stored),
        { ...claimData(accountId, [], legacy), releasing_until: Date.now() + RELEASE_MS });
      if (!releasing) continue;
      await store.deleteDoc(path);
      return;
    }
    if (await store.compareAndUpdateDoc<StoredClaim>(path, current => sameVersion(current, stored), claimData(accountId, next, legacy))) return;
  }
  throw new ConnectionError('The Cloudflare account is being updated by another request. Try again.', 409, 'revision_conflict');
}

function claimData(accountId: string, members: CloudflareAccountMember[], legacy: string | null): CloudflareAccountClaim {
  return plain({ schema: 2 as const, provider: 'cloudflare' as const, account_id: accountId, revision: randomUUID(), members,
    org_id: members[0]?.org_id ?? null, legacy_org_id: legacy, releasing_until: null });
}

/** Optimistic concurrency: v2 documents carry a revision; a single-owner document is matched by its shape. */
function sameVersion(current: StoredClaim, read: StoredClaim): boolean {
  if (read.schema === 2) return current.schema === 2 && current.revision === read.revision;
  return current.schema !== 2 && current.org_id === read.org_id && current.revision === read.revision;
}

/**
 * Join, run the save that connects the Hosting Group, and undo a membership this call added when the save fails,
 * so a failed connection never keeps blocking or admitting anyone.
 */
export async function withCloudflareAccountMembership<T>(actor: Actor, accountId: string, groupId: string, options: { confirmed?: boolean; accountName?: string }, save: () => Promise<T>): Promise<T> {
  const joined = await joinCloudflareAccount(actor, accountId, groupId, options);
  try { return await save(); }
  catch (error) {
    if (joined.added) await leaveCloudflareAccount(actor.orgId, accountId, groupId).catch(() => undefined);
    throw error;
  }
}

// ─── Resource names and ownership ────────────────────────────────────────

const hex = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/**
 * Names Core generates in a Cloudflare account. Every one is derived from the Organization (and Site) identity,
 * so Organizations sharing an account never generate the same name. These are the names Core has always used:
 * existing resources keep them and are never renamed or moved. A saved name (a bucket chosen when connecting with
 * API keys, or the Pages project of a migrated site) takes precedence over a generated one.
 */
export function generatedCloudflareNames(orgId: string, siteId?: string) {
  return {
    /** Private originals bucket and public images bucket of the Organization's shared media. */
    media_bucket: `typeroll-media-${hex(orgId)}`,
    public_bucket: `typeroll-public-${hex(orgId)}`,
    /** Worker that anchors the Organization's shared build engine, and its ownership tag. */
    build_worker: `typeroll-builder-${hex(orgId)}`,
    build_worker_tag: `typeroll-build-${hex(orgId)}`,
    ...(siteId === undefined ? {} : {
      /** A Site's Pages project (also its GitHub repository name) and the label of its generated hostnames. */
      pages_project: `typeroll-${hex(`${orgId}\0${siteId}`)}`,
      site_label: `site-${hex(`${orgId}\0${siteId}`)}`,
    }),
  };
}

/** The media transfer Worker is per Organization and per Typeroll server origin. */
export function mediaTransferWorkerName(orgId: string, origin: string) {
  return `typeroll-media-${hex(`${origin}\0${orgId}`)}`;
}

export type CloudflareResourceKind = 'r2_bucket' | 'pages_project' | 'worker';
interface ResourceRecord { provider: 'cloudflare'; account_id: string; kind: CloudflareResourceKind; name: string; org_id: string; site_id: string | null; recorded_at: string }

function resourcePath(accountId: string, kind: CloudflareResourceKind, name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(name)) throw new ConnectionError('Invalid Cloudflare resource name', 400);
  return `publishing_account_resources/cloudflare-${accountSegment(accountId)}-${kind}-${name}`;
}

export async function cloudflareResourceOwner(accountId: string, kind: CloudflareResourceKind, name: string): Promise<string | null> {
  return (await getStore().getDoc<ResourceRecord>(resourcePath(accountId, kind, name)))?.org_id ?? null;
}

function resourceConflict(kind: CloudflareResourceKind, name: string) {
  const label = kind === 'r2_bucket' ? 'R2 bucket' : kind === 'pages_project' ? 'Cloudflare Pages project' : 'Worker';
  return new ConnectionError(`The ${label} ${name} belongs to another Typeroll Organization that uses this Cloudflare account. Typeroll has not changed it. Choose another name or use the Organization that owns it.`, 409, 'cloudflare_resource_owned_by_other_organization');
}

/** Throws when another Organization's ownership record exists. Checks only; see claimCloudflareResource. */
export async function assertCloudflareResourceAvailable(orgId: string, accountId: string, kind: CloudflareResourceKind, name: string): Promise<void> {
  const owner = await cloudflareResourceOwner(accountId, kind, name);
  if (owner && owner !== orgId) throw resourceConflict(kind, name);
  if (kind !== 'r2_bucket' || owner) return;
  // Buckets saved in the connection of another Organization using the account are its own, recorded or not.
  const claim = await getStore().getDoc<StoredClaim>(cloudflareClaimPath(accountId));
  const others = new Set([...(await membersOf(claim, accountId)).map(member => member.org_id), ...(claim && claim.schema !== 2 && claim.org_id ? [claim.org_id] : [])]);
  others.delete(orgId);
  for (const other of others) {
    const connection = await getStore().getDoc<Connection>(connectionPath(other, 'cloudflare')).catch(() => null);
    if (connection?.cloudflare?.account_id === accountId && [connection.cloudflare.bucket, connection.cloudflare.public_bucket].includes(name)) throw resourceConflict(kind, name);
  }
}

/**
 * Record that this Organization owns a resource in the account, before Core creates or changes it, and throw
 * when another Organization's record exists. Callers pass only names that come from this Organization's own
 * records: names generated from its (and its Site's) identity, or the bucket saved in its connection. Before an
 * account could be shared it belonged to exactly one Organization; the buckets of such an Organization are
 * recorded when its claim is upgraded, and its generated names cannot be generated by any other Organization.
 */
export async function claimCloudflareResource(orgId: string, accountId: string, kind: CloudflareResourceKind, name: string, meta: { siteId?: string } = {}): Promise<void> {
  const store = getStore(), path = resourcePath(accountId, kind, name);
  const existing = await store.getDoc<ResourceRecord>(path);
  if (existing) {
    if (existing.org_id !== orgId) throw resourceConflict(kind, name);
    return;
  }
  await assertCloudflareResourceAvailable(orgId, accountId, kind, name);
  await store.createDocIfMissing(path, { provider: 'cloudflare', account_id: accountId, kind, name, org_id: orgId, site_id: meta.siteId ?? null,
    recorded_at: new Date().toISOString() } satisfies ResourceRecord);
  const recorded = await store.getDoc<ResourceRecord>(path);
  if (recorded?.org_id !== orgId) throw resourceConflict(kind, name);
}

/** Record the buckets an Organization's connection names, for example before an older claim is upgraded or removed. */
async function recordConnectionBuckets(orgId: string, accountId: string): Promise<void> {
  const connection = await getStore().getDoc<Connection>(connectionPath(orgId, 'cloudflare')).catch(() => null);
  if (connection?.cloudflare?.account_id !== accountId) return;
  for (const bucket of [connection.cloudflare.bucket, connection.cloudflare.public_bucket]) {
    if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) continue;
    await getStore().createDocIfMissing(resourcePath(accountId, 'r2_bucket', bucket), { provider: 'cloudflare', account_id: accountId, kind: 'r2_bucket', name: bucket,
      org_id: orgId, site_id: null, recorded_at: new Date().toISOString() } satisfies ResourceRecord);
  }
}

/**
 * A traffic record that points at a Pages project another Organization owns in the same account belongs to that
 * Organization's site. Never prepare or approve replacing it from here.
 */
export async function assertTrafficNotOwnedByOtherOrganization(orgId: string, accountId: string, records: Array<{ type: string; content: string }>): Promise<void> {
  for (const record of records) {
    if (record.type !== 'CNAME') continue;
    const match = /^(?:[a-z0-9-]+\.)?([a-z0-9-]{1,58})\.pages\.dev\.?$/.exec(record.content.toLowerCase());
    if (!match) continue;
    const owner = await cloudflareResourceOwner(accountId, 'pages_project', match[1]);
    if (owner && owner !== orgId) throw new ConnectionError('This hostname serves a site of another Typeroll Organization that uses the same Cloudflare account. Typeroll will not replace it. Choose another hostname, or remove it from the other site first.', 409, 'hostname_used_by_other_organization');
  }
}
