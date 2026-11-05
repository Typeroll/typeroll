// A full offline rehearsal of the cutover data steps: a Firestore-shaped tree
// (stored through the real Firestore codec) → export → import into SQLite
// objects sharded like production → read-compare, plus re-import, resume,
// conflicts, corruption, dry runs, identity and the export back out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeFirestoreDocument } from '../../lib/firestore-codec';
import {
  bufferByteSource, compareFailed, compareStep, createPortalAuth, exportStore, firestoreSource, importFailed, importLines,
  importIdentityExport, importStep, localShardedTarget, newCompareCheckpoint, newImportCheckpoint, readLines, readStep,
  shardedReader, sqlSource, sqliteFileObject, verifyExport, emptyImportReport,
  type ByteSource, type ExportManifest, type FirestoreCollectionLike, type FirestoreDocRefLike, type FirestoreLike,
  type ImportCheckpoint, type LocalShardedTarget,
} from '../../lib/migration';

// ─── A Firestore stand-in holding documents as FirestoreStore stores them ───

class Timestamp {
  constructor(readonly seconds: number, readonly nanoseconds: number) {}
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
}

class FakeFirestore implements FirestoreLike {
  readonly docs = new Map<string, Record<string, any>>();
  /** As FirestoreStore.setDoc writes it. */
  set(docPath: string, data: Record<string, any>) { this.docs.set(docPath, encodeFirestoreDocument(docPath, data)); }
  private children(prefix: string, depth: number): string[] {
    const found = new Set<string>();
    for (const key of this.docs.keys()) {
      const parts = key.split('/');
      if (parts.length > depth && (!prefix || key.startsWith(`${prefix}/`))) found.add(parts.slice(0, depth + 1).join('/'));
    }
    // Firestore lists in no particular order; prove the walk sorts.
    return [...found].reverse();
  }
  private collection(collectionPath: string): FirestoreCollectionLike {
    return { id: collectionPath.split('/').at(-1)!, listDocuments: async () => this.children(collectionPath, collectionPath.split('/').length).map(p => this.doc(p)) };
  }
  private doc(docPath: string): FirestoreDocRefLike {
    return { id: docPath.split('/').at(-1)!, path: docPath, listCollections: async () => this.children(docPath, docPath.split('/').length).map(p => this.collection(p)) };
  }
  async listCollections() { return this.children('', 0).map(p => this.collection(p)); }
  async getAll(...refs: FirestoreDocRefLike[]) {
    return refs.map(ref => ({ exists: this.docs.has(ref.path), ref: { path: ref.path }, data: () => this.docs.get(ref.path) }));
  }
}

const block = (id: string, text: string, slots: any[][] = []) => ({ id, type: 'section', props: { text }, slots });
const tree = [block('a', 'Hello', [[block('b', 'Left')], [block('c', 'Right', [[block('d', 'Deep')]])]]), block('e', 'Footer')];
const SITE = 'organizations/acme/sites/www';
const PAGE = `${SITE}/versions/main/pages/home`;

function seed(): FakeFirestore {
  const db = new FakeFirestore();
  db.set('organizations/acme', { name: 'Acme', service_access: { initial_period: { ends_at: '2026-12-01T00:00:00.000Z' } } });
  db.docs.set('organizations/acme', { ...db.docs.get('organizations/acme')!, created_at: new Timestamp(1_700_000_000, 123_456_789) });
  db.set('organizations/acme/members/u1', { role: 'owner', firebase_uid: 'u1', email: 'owner@example.test' });
  db.set('organizations/acme/api_keys/k1', { label: 'CI', secret_encrypted: 'enc:v1:aGVsbG8=' });
  db.set(SITE, { name: 'WWW', auto_deploy: { enabled: true, debounce_minutes: 15 }, pending_deploy_at: '2026-11-05T10:00:00.000Z' });
  db.set(`${SITE}/versions/main`, { name: 'main' });
  db.set(PAGE, { id: 'home', title: 'Home', status: 'published', blocks: tree, publish_at: '2026-11-01T00:00:00.000Z' });
  db.set(`${PAGE}/revisions/r1`, { doc: { title: 'Old home', blocks: tree }, created_at: '2026-10-01T00:00:00.000Z' });
  // A deleted page whose revisions survive (missing parent document).
  db.set(`${SITE}/versions/main/pages/gone/revisions/r1`, { doc: { title: 'Gone', blocks: [] } });
  db.set(`${SITE}/versions/main/partials/header`, { blocks: [block('h', 'Logo')] });
  db.set(`${SITE}/versions/main/working_copies/home`, { fields: { title: 'Draft', blocks: tree } });
  db.set(`${SITE}/versions/main/page_templates/t1`, { name: 'Article', blocks: [block('t', 'Body')] });
  db.set(`${SITE}/deploys/d1`, { status: 'succeeded', version_id: 'main', environment: 'production', finished_at: '2026-11-04T12:00:00.000Z' });
  db.set(`${SITE}/forms/contact/submissions/s1`, { fields: { email: 'visitor@example.test' }, matrix: [[1, 2], [3]] });
  db.set(`${SITE}/mail_deliveries/m1`, { state: 'sent' });
  db.set('organizations/acme/sites/www-old', { name: 'Old site' });
  db.set('organizations/acme/sites/www-old/versions/main/pages/p', { title: 'Legacy', blocks: [block('x', 'Legacy')] });
  db.set('organizations/beta', { name: 'Beta' });
  db.set('organizations/beta/sites/blog', { name: 'Blog', icon: Buffer.from('png') as any });
  db.set('organizations/beta/sites/blog/versions/main/pages/post', { title: 'Post', blocks: [], score: Number.NaN });
  db.set('api_key_lookup/0f1e', { org: 'acme', key_id: 'k1' });
  db.set('user_organizations/u1', { organizations: ['acme', 'beta'] });
  db.set('scheduled_work/abc', { kind: 'site_publish', source: SITE, due_at: 1_762_337_700_000, generation: 'g', payload: {}, lease_until: 0, lease_owner: null });
  db.set('mail_delivery_routes/r1', { org: 'acme', site: 'www' });
  db.set('fallback_hostnames/www-acme', { org: 'acme', site: 'www' });
  db.set('typeroll_system/installation', { schema: 2 });
  // Obsolete after the Better Auth switch and the move off Cloud Tasks.
  db.set('revoked_sessions/s1', { uid_hash: 'x' });
  db.set('session_lineage/l1', { uid_hash: 'x' });
  db.set('auth_rate_limits/h1', { count: 3 });
  db.set('typeroll_system/deploy_queue/items/q1', { site: 'www' });
  return db;
}

const DROPPED = 4;

async function exportOf(db: FirestoreLike): Promise<{ bytes: Buffer; manifest: ExportManifest }> {
  const lines: string[] = [];
  const manifest = await exportStore(firestoreSource(db, { label: 'firestore:test', batch: 3, concurrency: 2 }), line => { lines.push(line); }, { createdAt: '2026-11-05T00:00:00.000Z' });
  return { bytes: Buffer.from(lines.map(line => `${line}\n`).join('')), manifest };
}

async function runImport(target: LocalShardedTarget, source: ByteSource, manifest: ExportManifest, opts: { force?: boolean; dryRun?: boolean; maxBytes?: number } = {}, from?: ImportCheckpoint) {
  let checkpoint = from ?? newImportCheckpoint(manifest, opts);
  while (!checkpoint.done) checkpoint = await importStep(target, source, manifest, checkpoint, opts);
  return checkpoint;
}

async function runCompare(target: LocalShardedTarget, source: ByteSource, manifest: ExportManifest) {
  let checkpoint = newCompareCheckpoint(manifest);
  while (!checkpoint.done) checkpoint = await compareStep(shardedReader(target), source, manifest, checkpoint, { maxBytes: 2048 });
  return checkpoint.report;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('export', () => {
  it('is deterministic, complete and checksummed per collection and overall', async () => {
    const db = seed();
    const first = await exportOf(db), second = await exportOf(db);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest.records).toBe(db.docs.size);
    expect(first.manifest.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));
    expect(first.manifest.collections['organizations/sites/versions/pages/revisions'].count).toBe(2);
    expect(first.manifest.sites).toEqual(['acme/www', 'acme/www-old', 'beta/blog']);
    expect(first.manifest.organizations).toEqual(['acme', 'beta']);
    expect(first.manifest.firestore_types).toEqual({ bytes: 1, number: 1, timestamp: 1 });
    // Document before its subcollections, then `www-old` (segment order, not byte order).
    const paths = first.bytes.toString().trim().split('\n').map(line => JSON.parse(line).path as string);
    expect(paths.indexOf(`${SITE}/versions/main`)).toBeLessThan(paths.indexOf('organizations/acme/sites/www-old'));
    expect(paths).toContain(`${SITE}/versions/main/pages/gone/revisions/r1`);
    // Stored form: compressed trees and encrypted secrets exactly as Firestore holds them.
    const page = JSON.parse(first.bytes.toString().split('\n').find(line => line.includes(`"path":"${PAGE}"`))!);
    expect(Object.keys(page.data.blocks)).toEqual(['_tr_blocks_gz_']);
    expect(first.bytes.toString()).toContain('enc:v1:aGVsbG8=');
    expect((await verifyExport(readLines([first.bytes]), first.manifest)).ok).toBe(true);
  });

  it('reports a changed record by collection and a damaged line by number', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const lines = bytes.toString().split('\n');
    const index = lines.findIndex(line => line.includes('"path":"organizations/acme/members/u1"'));
    const changed = [...lines]; changed[index] = changed[index]!.replace('"owner"', '"admin"');
    const verified = await verifyExport(readLines([Buffer.from(changed.join('\n'))]), manifest);
    expect(verified.ok).toBe(false);
    expect(verified.problems).toEqual(['collection organizations/members: checksum differs', 'file checksum differs']);
    const damaged = [...lines]; damaged[index] = damaged[index]!.slice(0, 20);
    expect((await verifyExport(readLines([Buffer.from(damaged.join('\n'))]), manifest)).problems).toContain(`line ${index + 1}: invalid JSON`);
    const report = emptyImportReport();
    await importLines(localShardedTarget(dir), [{ line: index + 1, text: damaged[index]! }], {}, report);
    expect(report.errors).toEqual([{ line: index + 1, error: 'invalid JSON' }]);
    expect(importFailed(report)).toBe(true);
  });
});

describe('import and read-compare', () => {
  it('imports into sharded objects and compares with zero differences', async () => {
    const db = seed();
    const { bytes, manifest } = await exportOf(db);
    const source = bufferByteSource(bytes), target = localShardedTarget(dir);
    const result = await runImport(target, source, manifest, { maxBytes: 1024 });
    expect(importFailed(result.report)).toBe(false);
    expect(result.site_objects_created).toBe(3);
    expect(result.report).toMatchObject({ records: db.docs.size, created: db.docs.size - DROPPED, unchanged: 0, overwritten: 0, orgCopies: { created: 5 } });
    expect(Object.values(result.report.dropped).reduce((a, b) => a + b, 0)).toBe(DROPPED);

    const report = await runCompare(target, source, manifest);
    expect(compareFailed(report)).toBe(false);
    expect(report).toMatchObject({ records: db.docs.size, equal: db.docs.size - DROPPED, dropped: DROPPED, orgCopies: { equal: 5 } });
    expect(report.collections['organizations/sites/versions/pages']).toEqual({ compared: 3, equal: 3, different: 0, missing: 0, dropped: 0 });

    // Readers get plain JSON through the ordinary store: trees decoded, timestamps as ISO strings.
    const { store } = localShardedTarget(dir);
    expect(await store.getDoc(PAGE)).toEqual({ id: 'home', title: 'Home', status: 'published', blocks: tree, publish_at: '2026-11-01T00:00:00.000Z' });
    expect(await store.getDoc(`${PAGE}/revisions/r1`)).toMatchObject({ doc: { title: 'Old home', blocks: tree } });
    expect(await store.getDoc(`${SITE}/versions/main/working_copies/home`)).toMatchObject({ fields: { blocks: tree } });
    expect(await store.getDoc(`${SITE}/forms/contact/submissions/s1`)).toMatchObject({ matrix: [[1, 2], [3]] });
    expect(await store.getDoc('organizations/acme')).toMatchObject({ created_at: '2023-11-14T22:13:20.123Z' });
    expect(await store.getDoc('organizations/beta/sites/blog')).toMatchObject({ icon: Buffer.from('png').toString('base64') });
    expect(await store.getDoc('organizations/beta/sites/blog/versions/main/pages/post')).toMatchObject({ score: null });
    expect((await store.listDocs('organizations/acme/sites')).map(site => site.id)).toEqual(['www', 'www-old']);
    expect(await store.getDoc('revoked_sessions/s1')).toBeNull();
    expect(await store.getDoc('typeroll_system/deploy_queue/items/q1')).toBeNull();
    expect(await store.getDoc('typeroll_system/installation')).toEqual({ id: 'installation', schema: 2 });
    // Site data lives in the site's object, global indexes in the global one.
    const uid = (await store.getDoc<{ uid: string }>('site_owners/acme:www'))!.uid;
    expect(target.transport(`site:${uid}`)).toBeDefined();
    expect(await localShardedTarget(dir).transport(`site:${uid}`).get(PAGE)).not.toBeNull();
    expect(await localShardedTarget(dir).transport('global').get('scheduled_work/abc')).not.toBeNull();
    expect(await localShardedTarget(dir).transport('org:acme').get('organizations/acme/api_keys/k1')).toMatchObject({ data: { secret_encrypted: 'enc:v1:aGVsbG8=' } });
  });

  it('re-imports idempotently', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const source = bufferByteSource(bytes);
    const first = await runImport(localShardedTarget(dir), source, manifest);
    const again = await runImport(localShardedTarget(dir), source, manifest);
    expect(again.site_objects_created).toBe(0);
    expect(again.report).toMatchObject({ created: 0, unchanged: first.report.created, overwritten: 0, conflicts: [], orgCopies: { created: 0, unchanged: 5 } });
  });

  it('resumes from a checkpoint after an interruption, also inside a step', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const source = bufferByteSource(bytes);
    let checkpoint = newImportCheckpoint(manifest, {});
    for (let i = 0; i < 3; i++) checkpoint = await importStep(localShardedTarget(dir), source, manifest, checkpoint, { maxBytes: 1024 });
    expect(checkpoint.done).toBe(false);
    // The process dies after writing part of the next step but before saving the checkpoint.
    const saved = JSON.parse(JSON.stringify(checkpoint)) as ImportCheckpoint;
    const partial = await readStep(source, saved.cursor, 1024);
    await importLines(localShardedTarget(dir), partial.lines.slice(0, 1), {}, emptyImportReport());
    const resumed = await runImport(localShardedTarget(dir), source, manifest, { maxBytes: 1024 }, saved);
    expect(importFailed(resumed.report)).toBe(false);
    expect(resumed.report.created + resumed.report.unchanged).toBe(manifest.records - DROPPED);
    expect(resumed.report.unchanged).toBe(1);
    expect(compareFailed(await runCompare(localShardedTarget(dir), source, manifest))).toBe(false);
    await expect(importStep(localShardedTarget(dir), source, { ...manifest, sha256: 'other' }, saved)).rejects.toThrow(/another export/);
  });

  it('leaves a document that differs alone unless forced, and the compare names it', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const source = bufferByteSource(bytes);
    await runImport(localShardedTarget(dir), source, manifest);
    const { store } = localShardedTarget(dir);
    await store.updateDoc(PAGE, { title: 'Edited on Cloudflare' });
    await store.updateDoc(SITE, { name: 'Renamed' });

    const report = await runCompare(localShardedTarget(dir), source, manifest);
    expect(compareFailed(report)).toBe(true);
    expect(report.different.map(item => [item.path, item.at])).toEqual([[SITE, '/name'], [PAGE, '/title']]);

    const kept = await runImport(localShardedTarget(dir), source, manifest);
    expect(kept.report.conflicts.map(item => item.path)).toEqual([SITE, PAGE]);
    expect(importFailed(kept.report)).toBe(true);
    expect(await store.getDoc(PAGE)).toMatchObject({ title: 'Edited on Cloudflare' });

    const forced = await runImport(localShardedTarget(dir), source, manifest, { force: true });
    expect(forced.report).toMatchObject({ overwritten: 2, conflicts: [], orgCopies: { updated: 1 } });
    expect(compareFailed(await runCompare(localShardedTarget(dir), source, manifest))).toBe(false);
  });

  it('reports a missing document', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const source = bufferByteSource(bytes);
    await runImport(localShardedTarget(dir), source, manifest);
    await localShardedTarget(dir).store.deleteDoc('user_organizations/u1');
    const report = await runCompare(localShardedTarget(dir), source, manifest);
    expect(report.missing.map(item => item.path)).toEqual(['user_organizations/u1']);
  });

  it('writes nothing in a dry run', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const result = await runImport(localShardedTarget(dir), bufferByteSource(bytes), manifest, { dryRun: true });
    expect(result.report).toMatchObject({ created: manifest.records - DROPPED, conflicts: [], errors: [] });
    expect(result.site_objects_created).toBe(3);
    expect(await localShardedTarget(dir).transport('global').get('site_owners/acme:www')).toBeNull();
    for (const object of localShardedTarget(dir).objects()) for await (const found of object.paths()) expect.fail(`${object.name} holds ${found}`);
  });

  it('keeps a document above the row limit compressed and still compares it as equal', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const source = bufferByteSource(bytes), target = localShardedTarget(dir);
    let checkpoint = newImportCheckpoint(manifest, {});
    while (!checkpoint.done) checkpoint = await importStep(target, source, manifest, checkpoint, { maxDocumentBytes: 405 });
    expect(checkpoint.report.compressed).toEqual([PAGE]);
    expect(checkpoint.report.errors).toEqual([]);
    expect((await target.store.getDoc<any>(PAGE))!.blocks).toHaveProperty('_tr_blocks_gz_');
    let compare = newCompareCheckpoint(manifest);
    while (!compare.done) compare = await compareStep(shardedReader(target), source, manifest, compare, { maxDocumentBytes: 405 });
    expect(compareFailed(compare.report)).toBe(false);
  });

  it('exports the imported objects back out to the same documents', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const source = bufferByteSource(bytes), target = localShardedTarget(dir);
    await runImport(target, source, manifest);
    const skipped: Record<string, number> = {};
    const lines: string[] = [];
    const back = await exportStore(sqlSource(target.objects(), { label: 'local', skipped }), line => { lines.push(line); });
    // The import's own documents (site ownership rows) are added, dropped collections are gone.
    expect(back.records).toBe(manifest.records - DROPPED + 3);
    expect(back.sites).toEqual(manifest.sites);
    // Copies of site documents (in organizations) and organizations (in the global object) are not exported twice.
    expect(skipped['org:acme']).toBe(2);
    // Read back into a fresh target, the round trip compares equal against the original export.
    const second = localShardedTarget(path.join(dir, 'second'));
    const replay = Buffer.from(lines.map(line => `${line}\n`).join(''));
    await runImport(second, bufferByteSource(replay), back);
    expect(compareFailed(await runCompare(second, source, manifest))).toBe(false);
  });

  it('exports an unsharded SQLite store', async () => {
    const { bytes, manifest } = await exportOf(seed());
    const target = localShardedTarget(dir);
    await runImport(target, bufferByteSource(bytes), manifest);
    const lines: string[] = [];
    const single = await exportStore(sqlSource([sqliteFileObject(path.join(dir, 'global.sqlite'))]), line => { lines.push(line); });
    expect(lines.some(line => line.includes('"path":"scheduled_work/abc"'))).toBe(true);
    expect(single.collections.site_owners.count).toBe(3);
  });

  it('imports Firebase users into the target with their UIDs', async () => {
    const target = localShardedTarget(dir);
    const auth = createPortalAuth({ secret: 'migration-test-secret-0123456789abcdef', baseURL: 'http://localhost:4321', store: () => target.store });
    const users = { users: [
      { localId: 'u1', email: 'Owner@Example.test', emailVerified: true, salt: 'c2FsdA==', passwordHash: 'aGFzaA==' },
      { localId: 'u2' },
    ] };
    const report = await importIdentityExport(auth, JSON.stringify(users));
    expect(report).toMatchObject({ users: 2, created: 1, accountsCreated: 1, skipped: [{ uid: 'u2', reason: 'no email address' }] });
    expect(await target.transport('global').get('auth_user/u1')).toMatchObject({ data: { email: 'owner@example.test' } });
    await expect(importIdentityExport(auth, '{}')).rejects.toThrow(/users/);
  });
});
