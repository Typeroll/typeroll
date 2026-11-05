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
import { deepEqual, deepMerge, type Filter } from './sql-engine';
import { SqlStore, type StoreTransport } from './sql-store';

export type Shard = { kind: 'global' } | { kind: 'org'; org: string } | { kind: 'site'; org: string; site: string };

const SITE = /^organizations\/([^/]+)\/sites\/([^/]+)(?:\/|$)/;
const ORG = /^organizations\/([^/]+)(?:\/|$)/;

/** Which object holds a document path, or the documents of a collection path. */
export function shardFor(path: string): Shard {
  const site = path.match(SITE);
  if (site) return { kind: 'site', org: site[1]!, site: site[2]! };
  const org = path.match(ORG);
  if (org) return { kind: 'org', org: org[1]! };
  return { kind: 'global' };
}

const isSiteDoc = (path: string) => /^organizations\/[^/]+\/sites\/[^/]+$/.test(path);
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
    if (shard.kind === 'global') return 'global';
    if (shard.kind === 'org') return `org:${shard.org}`;
    return `site:${await this.siteUid(shard.org, shard.site)}`;
  }
  private async storeFor(path: string) { return this.store(await this.shardName(path)); }

  private async applyOutbox(source: string, id: string, entry: OutboxEntry) {
    for (const write of entry.writes) {
      const target = this.store(write.shard);
      if (write.data) await target.setDoc(write.path, write.data);
      else await target.deleteDoc(write.path);
    }
    await this.store(source).deleteDoc(`${OUTBOX}/${id}`);
  }

  /** Re-apply outbox entries a crash left behind in one object. Safe to repeat. */
  async drainOutbox(shard: string): Promise<number> {
    const pending = await this.store(shard).listDocs<OutboxEntry>(OUTBOX);
    for (const entry of pending) await this.applyOutbox(shard, entry.id, entry);
    return pending.length;
  }

  /**
   * A site document lives in the site's object; its organization keeps a copy
   * so it can list its sites. Both change in one commit through the outbox.
   */
  private async siteDoc<T>(path: string, decide: Parameters<SqlStore['mutate']>[1] extends (...args: infer A) => any ? (...args: A) => { after: Record<string, any> | null; result: T } | { skip: true; result: T } : never): Promise<T> {
    const source = await this.shardName(path), org = shardFor(path) as { org: string };
    const id = randomUUID();
    let entry: OutboxEntry | null = null;
    const result = await this.store(source).mutate(path, decide, after => {
      entry = { writes: [{ shard: `org:${org.org}`, path, data: after }], created_at: Date.now() };
      return [{ path: `${OUTBOX}/${id}`, data: entry }];
    });
    if (entry && await this.store(source).getDoc(`${OUTBOX}/${id}`)) await this.applyOutbox(source, id, entry);
    return result;
  }

  async getDoc<T = unknown>(path: string): Promise<(T & { id: string }) | null> {
    return (await this.storeFor(path)).getDoc<T>(path);
  }

  async setDoc(path: string, data: Record<string, any>): Promise<void> {
    if (isSiteDoc(path)) return this.siteDoc(path, () => ({ after: data, result: undefined }));
    await (await this.storeFor(path)).setDoc(path, data);
  }

  async createDocIfMissing(path: string, data: Record<string, any>): Promise<boolean> {
    if (isSiteDoc(path)) return this.siteDoc(path, before => before ? { skip: true, result: false } : { after: data, result: true });
    return (await this.storeFor(path)).createDocIfMissing(path, data);
  }

  async updateDoc(path: string, data: Record<string, any>): Promise<void> {
    if (isSiteDoc(path)) return this.siteDoc(path, before => ({ after: deepMerge(before ?? {}, data), result: undefined }));
    await (await this.storeFor(path)).updateDoc(path, data);
  }

  async deleteDoc(path: string): Promise<void> {
    if (isSiteDoc(path)) return this.siteDoc(path, () => ({ after: null, result: undefined }));
    await (await this.storeFor(path)).deleteDoc(path);
  }

  async compareAndUpdateDoc<T = unknown>(path: string, check: (current: T & { id: string }) => boolean, data: Record<string, any>): Promise<(T & { id: string }) | null> {
    if (isSiteDoc(path)) return this.siteDoc<(T & { id: string }) | null>(path, before =>
      before && check(structuredClone(before) as T & { id: string }) ? { after: deepMerge(before, data), result: before as T & { id: string } } : { skip: true, result: null });
    return (await this.storeFor(path)).compareAndUpdateDoc(path, check, data);
  }

  async deleteTree(path: string): Promise<void> {
    if (isSiteDoc(path) || /^organizations\/[^/]+$/.test(path)) throw new Error(`deleteTree across objects is not supported: ${path}`);
    await (await this.storeFor(path)).deleteTree(path);
  }

  async listDocs<T = unknown>(collection: string, opts?: { filters?: Filter[]; limit?: number; startAfterId?: string }): Promise<Array<T & { id: string }>> {
    if (collection === 'organizations') throw new Error('Listing all organizations is not supported; use an index');
    // A collection lives with the document that owns it; root collections are global.
    const owner = collection.includes('/') ? collection.slice(0, collection.lastIndexOf('/')) : null;
    return (owner ? await this.storeFor(owner) : this.store('global')).listDocs<T>(collection, opts);
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
        // A merge into a site document becomes a guarded replacement, so its organization's copy is exact.
        if (isSiteDoc(effect.path) && !effect.guardOnly && !effect.replace) {
          const current = await store.getDoc(effect.path);
          own = { ...effect, data: deepMerge(current ?? {}, effect.data), replace: true, expected: Object.hasOwn(effect, 'expected') ? effect.expected : current };
          if (Object.hasOwn(effect, 'expected') && !deepEqual(effect.expected ?? null, current)) return false;
        }
        if (effect.path !== path) local.push(own);
        if (isSiteDoc(effect.path) && !effect.guardOnly) remote.push({ shard: `org:${(shardFor(effect.path) as { org: string }).org}`, path: effect.path, data: stripId(own.data) });
      }
      const id = randomUUID();
      const entry: OutboxEntry | null = remote.length ? { writes: remote, created_at: Date.now() } : null;
      if (await store.compareAndReplaceDoc(path, expected, data, entry ? [...local, { path: `${OUTBOX}/${id}`, data: entry, replace: true }] : local)) {
        if (entry) await this.applyOutbox(source, id, entry);
        return true;
      }
      // Retry only when a site document we read changed underneath; otherwise the caller's condition failed.
      const rewrote = effects.some(effect => isSiteDoc(effect.path) && !effect.replace && !Object.hasOwn(effect, 'expected'));
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
