import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadMigrationLibrary } from './lib/migration-library.mjs';
import { TRANSFER_PATH, backupFiles, backupStore, restoreStore, storeTransferClient } from './lib/self-host-cloudflare-backup.mjs';
import { main } from './self-host-cloudflare.mjs';

const TOKEN = 't'.repeat(40);
const ORIGIN = 'https://cms.example.org';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-host-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The portal's store transfer endpoint, implemented as the contract in
 * lib/self-host-cloudflare-backup.mjs describes, over local SQLite objects and
 * an in-memory EU bucket. `migration` follows runMigrationStep
 * (lib/migration/worker-run.ts): checkpoints live in the bucket under the run.
 */
function fakePortal(lib, dir, bucket) {
  const target = lib.localShardedTarget(dir);
  const calls = [];
  const object = name => {
    const found = target.objects().find(candidate => candidate.name === name);
    if (!found) throw new Error(`no object ${name}`);
    return found;
  };
  const readJson = key => bucket.has(key) ? JSON.parse(Buffer.from(bucket.get(key)).toString('utf8')) : null;
  const putJson = (key, value) => bucket.set(key, Buffer.from(JSON.stringify(value)));
  async function migration({ run, step, force }) {
    const key = name => `${run}/${name}`;
    const manifest = readJson(key('store.manifest.json'));
    if (!manifest) throw new Error('The run has no store.manifest.json');
    const source = () => lib.bufferByteSource(bucket.get(key('store.ndjson')));
    if (step === 'verify') {
      const result = await lib.verifyExport(lib.readLines([bucket.get(key('store.ndjson'))]), manifest);
      putJson(key('verify.json'), { ...result, manifest: null, export_sha256: manifest.sha256 });
    } else if (step === 'import') {
      if (!readJson(key('verify.json'))?.ok) throw new Error('Verify the export before importing it');
      const checkpoint = readJson(key('import-checkpoint.json')) ?? lib.newImportCheckpoint(manifest, { force: force === true });
      putJson(key('import-checkpoint.json'), await lib.importStep(target, source(), manifest, checkpoint, { force: force === true, maxBytes: 64 }));
    } else if (step === 'compare') {
      const checkpoint = readJson(key('compare-checkpoint.json')) ?? lib.newCompareCheckpoint(manifest);
      putJson(key('compare-checkpoint.json'), await lib.compareStep(lib.shardedReader(target), source(), manifest, checkpoint, { maxBytes: 64 }));
    }
    return { run, verify: readJson(key('verify.json')), import: readJson(key('import-checkpoint.json')), identity: null, compare: readJson(key('compare-checkpoint.json')) };
  }
  const handlers = {
    objects: () => ({ objects: target.objects().map(({ name, kind }) => ({ name, kind })) }),
    async paths({ object: name, after, limit }) {
      const all = [];
      for await (const p of object(name).paths()) all.push(p);
      const page = all.sort().filter(p => p > after).slice(0, limit);
      return { paths: page, next: page.length === limit ? page.at(-1) : null };
    },
    get_many: async ({ object: name, paths }) => ({ documents: (await object(name).getMany(paths)).map(doc => doc ? { data: doc.data } : null) }),
    migration,
  };
  return {
    target, calls,
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      calls.push(body.step ?? body.action);
      if (new URL(url).pathname !== TRANSFER_PATH || init.headers.Authorization !== `Bearer ${TOKEN}`) return new Response('Not found', { status: 404 });
      try { return new Response(JSON.stringify(await handlers[body.action](body))); }
      catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: 409 }); }
    },
  };
}

/** `wrangler r2 object put` into the in-memory bucket. */
function fakeWrangler(bucket, bucketName) {
  const puts = [];
  return {
    puts,
    async wrangler(args) {
      assert.deepEqual([args[0], args[1], args[2]], ['r2', 'object', 'put']);
      assert.ok(args.includes('--jurisdiction') && args[args.indexOf('--jurisdiction') + 1] === 'eu');
      const [name, ...key] = args[3].split('/');
      assert.equal(name, bucketName);
      bucket.set(key.join('/'), fs.readFileSync(args[args.indexOf('--file') + 1]));
      puts.push(key.join('/'));
      return '';
    },
  };
}

test('backs up a store through the portal and restores it into an empty installation', async t => {
  const lib = await loadMigrationLibrary();
  const dir = tempDir(t);
  const bucket = new Map();
  const source = fakePortal(lib, path.join(dir, 'source'), bucket);
  await source.target.store.setDoc('typeroll_system/installation', { data_schema_version: 2 });
  await source.target.store.setDoc('organizations/acme', { name: 'Acme' });
  await source.target.store.setDoc('organizations/acme/sites/www', { name: 'WWW' });
  await source.target.store.setDoc('organizations/acme/sites/www/versions/main/pages/home', { title: 'Home', blocks: [{ id: 'a', type: 'section', slots: [[{ id: 'b', type: 'text' }]] }] });
  await source.target.store.setDoc('auth_user/u1', { email: 'owner@example.test', name: 'Owner' });

  const backupDir = path.join(dir, 'backup');
  const { wrangler, puts } = fakeWrangler(bucket, 'typeroll-backups');
  const descriptor = await backupStore({
    lib, client: storeTransferClient({ origin: ORIGIN, token: TOKEN, fetch: source.fetch }), origin: ORIGIN, dir: backupDir,
    bucket: 'typeroll-backups', run: 'backup-20261105T120000Z', coreVersion: '0.3.0', deps: { wrangler }, now: () => '2026-11-05T12:00:00.000Z',
  });
  assert.equal(descriptor.format_version, 2);
  assert.equal(descriptor.source, 'cms.example.org');
  assert.ok(descriptor.records >= 5);
  assert.deepEqual(puts, ['backup-20261105T120000Z/store.ndjson', 'backup-20261105T120000Z/store.manifest.json']);
  for (const file of Object.values(backupFiles(backupDir))) assert.equal(fs.statSync(file).mode & 0o077, 0, `${file} is private`);
  await assert.rejects(backupStore({ lib, client: storeTransferClient({ origin: ORIGIN, token: TOKEN, fetch: source.fetch }), origin: ORIGIN, dir: backupDir,
    bucket: 'typeroll-backups', run: 'again', coreVersion: '0.3.0', deps: { wrangler } }), /Refusing to overwrite/);

  const restored = fakePortal(lib, path.join(dir, 'restored'), bucket);
  const client = storeTransferClient({ origin: ORIGIN, token: TOKEN, fetch: restored.fetch });
  const result = await restoreStore({ lib, client, dir: backupDir, bucket: 'typeroll-backups', deps: { wrangler } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.import.conflicts.length, 0);
  assert.deepEqual(result.compare.different, []);
  assert.deepEqual(await restored.target.store.getDoc('organizations/acme/sites/www/versions/main/pages/home'),
    await source.target.store.getDoc('organizations/acme/sites/www/versions/main/pages/home'));
  assert.deepEqual(await restored.target.store.getDoc('auth_user/u1'), { id: 'u1', email: 'owner@example.test', name: 'Owner' });
  assert.ok(restored.calls.filter(action => action === 'import').length > 1, 'the import runs in bounded steps');
  assert.equal(result.run, `restore-${descriptor.sha256.slice(0, 24)}`);

  // A rerun resumes from the checkpoints in the bucket and does nothing more.
  restored.calls.length = 0;
  assert.equal((await restoreStore({ lib, client, dir: backupDir, bucket: 'typeroll-backups', deps: { wrangler }, upload: false })).ok, true);
  assert.deepEqual(restored.calls, ['status']);
});

test('a restore reports documents that already differ instead of overwriting them', async t => {
  const lib = await loadMigrationLibrary();
  const dir = tempDir(t);
  const bucket = new Map();
  const source = fakePortal(lib, path.join(dir, 'source'), bucket);
  await source.target.store.setDoc('organizations/acme', { name: 'Acme' });
  const backupDir = path.join(dir, 'backup');
  const { wrangler } = fakeWrangler(bucket, 'typeroll-backups');
  await backupStore({ lib, client: storeTransferClient({ origin: ORIGIN, token: TOKEN, fetch: source.fetch }), origin: ORIGIN, dir: backupDir,
    bucket: 'typeroll-backups', run: 'backup-r1', coreVersion: '0.3.0', deps: { wrangler } });

  const target = fakePortal(lib, path.join(dir, 'target'), bucket);
  await target.target.store.setDoc('organizations/acme', { name: 'Changed since the backup' });
  const client = storeTransferClient({ origin: ORIGIN, token: TOKEN, fetch: target.fetch });
  const result = await restoreStore({ lib, client, dir: backupDir, bucket: 'typeroll-backups', deps: { wrangler } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.import.conflicts.map(conflict => conflict.path), ['organizations/acme']);
  assert.equal((await target.target.store.getDoc('organizations/acme')).name, 'Changed since the backup');
  // The import keeps the options it started with; forcing needs a new run.
  await assert.rejects(restoreStore({ lib, client, dir: backupDir, bucket: 'typeroll-backups', deps: { wrangler }, run: 'restore-again', force: true, upload: false }), /no store.manifest.json/);
  const forced = await restoreStore({ lib, client, dir: backupDir, bucket: 'typeroll-backups', deps: { wrangler }, run: 'restore-forced', force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.import.overwritten, 1);
  assert.equal((await target.target.store.getDoc('organizations/acme')).name, 'Acme');
});

test('refuses a damaged backup and an endpoint that does not accept the token', async t => {
  const lib = await loadMigrationLibrary();
  const dir = tempDir(t);
  const bucket = new Map();
  const source = fakePortal(lib, path.join(dir, 'source'), bucket);
  await source.target.store.setDoc('organizations/acme', { name: 'Acme' });
  const backupDir = path.join(dir, 'backup');
  const { wrangler } = fakeWrangler(bucket, 'typeroll-backups');
  await backupStore({ lib, client: storeTransferClient({ origin: ORIGIN, token: TOKEN, fetch: source.fetch }), origin: ORIGIN, dir: backupDir,
    bucket: 'typeroll-backups', run: 'backup-r1', coreVersion: '0.3.0', deps: { wrangler } });
  fs.appendFileSync(backupFiles(backupDir).data, '{"path":"organizations/evil","data":{}}\n');
  await assert.rejects(restoreStore({ lib, client: storeTransferClient({ origin: ORIGIN, token: TOKEN, fetch: source.fetch }), dir: backupDir, bucket: 'typeroll-backups', deps: { wrangler } }), /does not match its manifest/);

  assert.throws(() => storeTransferClient({ origin: ORIGIN, token: 'short', fetch: source.fetch }), /at least 32 characters/);
  const wrong = storeTransferClient({ origin: ORIGIN, token: 'w'.repeat(40), fetch: source.fetch });
  await assert.rejects(wrong.objects(), /not available at cms\.example\.org/);
});

test('the CLI restores only into the exactly confirmed portal host', async t => {
  const dir = tempDir(t);
  const config = path.join(dir, 'self-host.cloudflare.json');
  fs.writeFileSync(config, JSON.stringify({ account_id: '0123456789abcdef0123456789abcdef', portal_host: 'cms.example.org', forms_host: 'forms.example.org', media_public_url: 'https://media.example.org' }));
  const logs = [];
  const run = confirm => main(['restore', '--config', config, '--secrets-env', '--in', dir, ...(confirm ? ['--confirm', confirm] : [])], {
    env: { TYPEROLL_STORE_TRANSFER_TOKEN: TOKEN }, deps: { fetch: async () => new Response('Not found', { status: 404 }) },
    loadMigrationLibrary, log: message => logs.push(message), out: () => {},
  });
  assert.equal(await run('other.example.org'), 2);
  assert.match(logs.join('\n'), /must exactly equal cms\.example\.org/);
  assert.equal(await run(), 2);
});
