// One logical store over many Durable Objects: one per site, one per
// organization, one global.
//
// A site's object is named by an immutable site uid from the global ownership
// index, so a site can move to another organization without moving its data.
// Writes that must reach another object (a site document's summary in its
// organization, a global lookup row) go through a transactional outbox: they
// are committed with the source write in the source object, then applied, and
// re-applied by `drainOutbox` after a crash. Only unconditional replacements
// may cross objects; a guard on another object cannot be atomic and is refused.

import { randomUUID } from 'node:crypto';
import type { ConditionalEffect, ReadWriteStore } from '../datastore';
import { clean, deepEqual, deepMerge, type Filter } from './sql-engine';
import { SqlStore, type StoreTransport } from './sql-store';

export type Shard = { kind: 'global' } | { kind: 'org'; org: string } | { kind: 'site'; org: string; site: string } | { kind: 'counter'; bucket: string };

const SITE = /^organizations\/([^/]+)\/sites\/([^/]+)(?:\/|$)/;
const ORG = /^organizations\/([^/]+)(?:\/|$)/;

/**
 * Rate-limit counters (hashed keys) are spread over 256 counter objects so hot
 * anonymous limits (forms, analytics, API) never queue behind the global object.
 */
const COUNTER = /^(?:rate_limits|auth_rate_limits)\/([0-9a-f]{2})[0-9a-f]{62}$/;
const COUNTER_COLLECTION = /^(?:rate_limits|auth_rate_limits)$/;

/** The object name of a shard that needs no lookup; null for a site (named by its uid). */
export function fixedObjectName(shard: Shard): string | null {
  if (shard.kind === 'global') return 'global';
  if (shard.kind === 'org') return `org:${shard.org}`;
  if (shard.kind === 'counter') return `counters:${shard.bucket}`;
  return null;
}

/** Which object holds a document path, or the documents of a collection path. */
export function shardFor(path: string): Shard {
  const counter = path.match(COUNTER);
  if (counter) return { kind: 'counter', bucket: counter[1]! };
  const site = path.match(SITE);
  if (site) return { kind: 'site', org: site[1]!, site: site[2]! };
  const org = path.match(ORG);
  if (org) return { kind: 'org', org: org[1]! };
  return { kind: 'global' };
}

const isSiteDoc = (path: string) => /^organizations\/[^/]+\/sites\/[^/]+$/.test(path);
const isOrgDoc = (path: string) => /^organizations\/[^/]+$/.test(path);
/**
 * Documents with a read-only copy in another object, written in the same
 * commit through the outbox: a site document in its organization's object (so
 * the organization can list its sites) and an organization document in the
 * global object (so organizations can be listed).
 */
const mirrorOf = (path: string): string | null =>
  isSiteDoc(path) ? `org:${(shardFor(path) as { org: string }).org}` : isOrgDoc(path) ? 'global' : null;
const isMirrored = (path: string) => mirrorOf(path) !== null;
/** Source revision stored on a copy; never returned to readers. */
export const MIRROR_REVISION = '_mirror_revision';
const isMirrorCollection = (collection: string) => collection === 'organizations' || /^organizations\/[^/]+\/sites$/.test(collection);
export function stripMirrorRevision<T extends Record<string, any>>(doc: T): T {
  if (!Object.hasOwn(doc, MIRROR_REVISION)) return doc;
  const { [MIRROR_REVISION]: _revision, ...rest } = doc;
  void _revision;
  return rest as T;
}
export const ownerPath = (org: string, site: string) => `site_owners/${org}:${site}`;
const OUTBOX = '_outbox';

interface OutboxEntry { writes: Array<{ shard: string; path: string; data: Record<string, any> | null }>; created_at: number }
export interface ShardResolver { transport(name: string): StoreTransport }

export class ShardedStore implements ReadWriteStore {
  private readonly stores = new Map<string, SqlStore>();
  private readonly uids = new Map<string, string>();

  constructor(private readonly resolver: ShardResolver, private readonly newId: () => string) {}

  private store(name: string): SqlStore {
    let store = this.stores.get(name);
    if (!store) { store = new SqlStore(this.resolver.transport(name), this.newId); this.stores.set(name, store); }
    return store;
  }

  /** The uid naming a site's object, assigned on first use. */
  async siteUid(org: string, site: string): Promise<string> {
    const key = `${org}:${site}`;
    const cached = this.uids.get(key);
    if (cached) return cached;
    const global = this.store('global'), path = ownerPath(org, site);
    if (!await global.getDoc(path)) await global.createDocIfMissing(path, { uid: randomUUID(), org, site });
    const uid = (await global.getDoc<{ uid: string }>(path))!.uid;
    this.uids.set(key, uid);
    return uid;
  }

  /** Object name for a document path (or `collection/_` for a collection). */
  async shardName(path: string): Promise<string> {
    const shard = shardFor(path);
    if (shard.kind !== 'site') return fixedObjectName(shard)!;
    return `site:${await this.siteUid(shard.org, shard.site)}`;
  }
  private async storeFor(path: string) { return this.store(await this.shardName(path)); }

  /** The store of one named object, e.g. for the scheduled work a Durable Object delivers. */
  objectStore(name: string): ReadWriteStore {
    return this.store(name);
  }

  private async applyOutbox(source: string, id: string, entry: OutboxEntry) {
    for (const write of entry.writes) {
      const target = this.store(write.shard);
      if (mirrorOf(write.path) === write.shard) {
        await this.copyMirror(source, write.shard, write.path);
        continue;
      }
      if (write.data) await target.setDoc(write.path, stripId(write.data));
      else await target.deleteDoc(write.path);
    }
    // Remove the entry only if nobody replaced it meanwhile (an entry with a fixed id is rewritten in place).
    const expected = clean(stripId(entry as unknown as Record<string, any>));
    await this.store(source).mutate(`${OUTBOX}/${id}`, before => before && deepEqual(stripId(before), expected)
      ? { after: null, result: undefined } : { skip: true, result: undefined });
  }

  /**
   * Copy a mirrored document as it is now in its own object. The copy carries
   * the source revision, so a slower writer holding an older value can never
   * overwrite a newer copy.
   */
  private async copyMirror(source: string, mirror: string, path: string) {
    const current = await this.resolver.transport(source).get(path);
    await this.store(mirror).mutate(path, before => {
      const copied = typeof before?.[MIRROR_REVISION] === 'number' ? before[MIRROR_REVISION] as number : -1;
      if (!current) return before ? { after: null, result: undefined } : { skip: true, result: undefined };
      if (copied >= current.revision) return { skip: true, result: undefined };
      return { after: { ...stripId(current.data), [MIRROR_REVISION]: current.revision }, result: undefined };
    });
  }

  /**
   * Re-apply outbox entries a crash left behind in one object, oldest first.
   * `minAgeMs` leaves fresh entries to the writer that is applying them. Safe to repeat.
   */
  async drainOutbox(shard: string, opts: { minAgeMs?: number; now?: number } = {}): Promise<number> {
    const cutoff = (opts.now ?? Date.now()) - (opts.minAgeMs ?? 0);
    const pending = (await this.store(shard).listDocs<OutboxEntry>(OUTBOX))
      .filter(entry => !(entry.created_at > cutoff))
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    for (const entry of pending) await this.applyOutbox(shard, entry.id, entry);
    return pending.length;
  }

  /** A mirrored document and its copy change in one commit through the outbox. */
  private async siteDoc<T>(path: string, decide: Parameters<SqlStore['mutate']>[1] extends (...args: infer A) => any ? (...args: A) => { after: Record<string, any> | null; result: T } | { skip: true; result: T } : never): Promise<T> {
    const source = await this.shardName(path), mirror = mirrorOf(path)!;
    const id = randomUUID();
    let entry: OutboxEntry | null = null;
    const result = await this.store(source).mutate(path, decide, after => {
      entry = { writes: [{ shard: mirror, path, data: after }], created_at: Date.now() };
      return [{ path: `${OUTBOX}/${id}`, data: entry }];
    });
    if (entry && await this.store(source).getDoc(`${OUTBOX}/${id}`)) await this.applyOutbox(source, id, entry);
    return result;
  }

  async getDoc<T = unknown>(path: string): Promise<(T & { id: string }) | null> {
    return (await this.storeFor(path)).getDoc<T>(path);
  }

  async setDoc(path: string, data: Record<string, any>): Promise<void> {
    if (isMirrored(path)) return this.siteDoc(path, () => ({ after: data, result: undefined }));
    await (await this.storeFor(path)).setDoc(path, data);
  }

  async createDocIfMissing(path: string, data: Record<string, any>): Promise<boolean> {
    if (isMirrored(path)) return this.siteDoc(path, before => before ? { skip: true, result: false } : { after: data, result: true });
    return (await this.storeFor(path)).createDocIfMissing(path, data);
  }

  async updateDoc(path: string, data: Record<string, any>): Promise<void> {
    if (isMirrored(path)) return this.siteDoc(path, before => ({ after: deepMerge(before ?? {}, data), result: undefined }));
    await (await this.storeFor(path)).updateDoc(path, data);
  }

  async deleteDoc(path: string): Promise<void> {
    if (isMirrored(path)) return this.siteDoc(path, () => ({ after: null, result: undefined }));
    await (await this.storeFor(path)).deleteDoc(path);
  }

  async compareAndUpdateDoc<T = unknown>(path: string, check: (current: T & { id: string }) => boolean, data: Record<string, any>): Promise<(T & { id: string }) | null> {
    if (isMirrored(path)) return this.siteDoc<(T & { id: string }) | null>(path, before =>
      before && check(structuredClone(before) as T & { id: string }) ? { after: deepMerge(before, data), result: before as T & { id: string } } : { skip: true, result: null });
    return (await this.storeFor(path)).compareAndUpdateDoc(path, check, data);
  }

  async deleteTree(path: string): Promise<void> {
    if (isSiteDoc(path) || /^organizations\/[^/]+$/.test(path)) throw new Error(`deleteTree across objects is not supported: ${path}`);
    await (await this.storeFor(path)).deleteTree(path);
  }

  async listDocs<T = unknown>(collection: string, opts?: { filters?: Filter[]; limit?: number; startAfterId?: string }): Promise<Array<T & { id: string }>> {
    if (COUNTER_COLLECTION.test(collection)) throw new Error(`${collection} is spread over counter objects and cannot be listed`);
    // Organizations are listed from their copies in the global object.
    if (collection === 'organizations') return (await this.store('global').listDocs<T>(collection, opts)).map(stripMirrorRevision);
    // A collection lives with the document that owns it; root collections are global.
    const owner = collection.includes('/') ? collection.slice(0, collection.lastIndexOf('/')) : null;
    const docs = await (owner ? await this.storeFor(owner) : this.store('global')).listDocs<T>(collection, opts);
    return isMirrorCollection(collection) ? docs.map(stripMirrorRevision) : docs;
  }

  async addDoc(collection: string, data: Record<string, any>): Promise<string> {
    const id = this.newId();
    await this.setDoc(`${collection}/${id}`, data);
    return id;
  }

  async compareAndReplaceDoc(path: string, expected: Record<string, any> | null, data: Record<string, any>, effects: ConditionalEffect[] = []): Promise<boolean> {
    const source = await this.shardName(path), store = this.store(source);
    for (let attempt = 0; attempt < 10; attempt++) {
      const local: ConditionalEffect[] = [], remote: OutboxEntry['writes'] = [];
      for (const effect of [{ path, data, replace: true } as ConditionalEffect, ...effects]) {
        const shard = await this.shardName(effect.path);
        if (shard !== source) {
          if (effect.guardOnly || Object.hasOwn(effect, 'expected') || !effect.replace) throw new Error(`A condition on ${effect.path} cannot be atomic with ${path}; only unconditional replacements may cross objects`);
          remote.push({ shard, path: effect.path, data: stripId(effect.data) });
          continue;
        }
        let own = effect;
        // A merge into a mirrored document becomes a guarded replacement, so its copy is exact.
        if (isMirrored(effect.path) && !effect.guardOnly && !effect.replace) {
          const current = await store.getDoc(effect.path);
          own = { ...effect, data: deepMerge(current ?? {}, effect.data), replace: true, expected: Object.hasOwn(effect, 'expected') ? effect.expected : current };
          if (Object.hasOwn(effect, 'expected') && !deepEqual(effect.expected ?? null, current)) return false;
        }
        if (effect.path !== path) local.push(own);
        if (isMirrored(effect.path) && !effect.guardOnly) remote.push({ shard: mirrorOf(effect.path)!, path: effect.path, data: stripId(own.data) });
      }
      const id = randomUUID();
      const entry: OutboxEntry | null = remote.length ? { writes: remote, created_at: Date.now() } : null;
      if (await store.compareAndReplaceDoc(path, expected, data, entry ? [...local, { path: `${OUTBOX}/${id}`, data: entry, replace: true }] : local)) {
        if (entry) await this.applyOutbox(source, id, entry);
        return true;
      }
      // Retry only when a site document we read changed underneath; otherwise the caller's condition failed.
      const rewrote = effects.some(effect => isMirrored(effect.path) && !effect.replace && !Object.hasOwn(effect, 'expected'));
      if (!rewrote || !deepEqual(await store.getDoc(path), expected ?? null)) return false;
    }
    return false;
  }

  async readSnapshot<T>(root: string, work: () => Promise<T>): Promise<T> {
    return (await this.storeFor(root)).readSnapshot(root, work);
  }
}

function stripId(value: Record<string, any>): Record<string, any> {
  const { id: _id, ...rest } = value;
  void _id;
  return rest;
}
