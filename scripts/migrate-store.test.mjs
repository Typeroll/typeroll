import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { main, manifestPathFor } from './migrate-store.mjs';
import { loadMigrationLibrary } from './lib/migration-library.mjs';

async function run(...argv) {
  const logs = [], outputs = [];
  const code = await main(argv, { log: message => logs.push(message), out: value => outputs.push(value) });
  return { code, logs: logs.join('\n'), output: outputs[0] };
}

/** A small source store (SQLite objects) holding documents in Firestore's stored form. */
async function sourceStore(dir) {
  const lib = await loadMigrationLibrary();
  const { store } = lib.localShardedTarget(dir);
  const tree = [{ id: 'a', type: 'section', slots: [[{ id: 'b', type: 'text' }]] }];
  await store.setDoc('organizations/acme', { name: 'Acme' });
  await store.setDoc('organizations/acme/sites/www', { name: 'WWW' });
  await store.setDoc('organizations/acme/sites/www/versions/main/pages/home', { title: 'Home', blocks: { _tr_blocks_gz_: gzipSync(JSON.stringify(tree)).toString('base64') } });
  await store.setDoc('user_organizations/u1', { organizations: ['acme'] });
  await store.setDoc('revoked_sessions/s1', { uid_hash: 'x' });
  return tree;
}

test('export, verify, import, re-import and compare through the CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-store-'));
  try {
    const tree = await sourceStore(path.join(dir, 'source'));
    const file = path.join(dir, 'store.ndjson');

    const dry = await run('export', '--source', `local:${path.join(dir, 'source')}`, '--out', file, '--dry-run');
    assert.equal(dry.code, 0);
    assert.equal(fs.existsSync(file), false);

    const exported = await run('export', '--source', `local:${path.join(dir, 'source')}`, '--out', file);
    assert.equal(exported.code, 0, exported.logs);
    // Five documents plus the source's own site ownership row.
    assert.equal(exported.output.records, 6);
    assert.ok(fs.existsSync(manifestPathFor(file)));
    assert.equal((await run('export', '--source', `local:${path.join(dir, 'source')}`, '--out', file)).code, 2, 'never overwrites an export');
    assert.deepEqual((await run('verify', '--in', file)).output, { ok: true, problems: [] });

    const target = `local:${path.join(dir, 'target')}`;
    const planned = await run('import', '--in', file, '--target', target, '--dry-run');
    assert.equal(planned.code, 0, planned.logs);
    assert.equal(planned.output.created, 4);
    assert.equal(planned.output.site_objects_created, 1);
    assert.equal(fs.existsSync(path.join(dir, 'target', 'import-checkpoint.json')), false);

    const users = path.join(dir, 'users.json');
    fs.writeFileSync(users, JSON.stringify({ users: [{ localId: 'u1', email: 'owner@example.test' }] }));
    const imported = await run('import', '--in', file, '--target', target, '--users', users, '--step-bytes', '64');
    assert.equal(imported.code, 0, imported.logs);
    assert.equal(imported.output.created, 4);
    assert.equal(imported.output.site_objects_created, 1);
    assert.equal(Object.values(imported.output.dropped).reduce((a, b) => a + b, 0), 2);
    assert.equal(imported.output.identity.created, 1);

    const lib = await loadMigrationLibrary();
    const { store } = lib.localShardedTarget(path.join(dir, 'target'));
    assert.deepEqual((await store.getDoc('organizations/acme/sites/www/versions/main/pages/home')).blocks, tree);
    assert.deepEqual((await store.listDocs('organizations/acme/sites')).map(site => site.id), ['www']);

    const again = await run('import', '--in', file, '--target', target);
    assert.equal(again.code, 0, again.logs);
    assert.equal(again.output.created, 4, 'a finished import reports its checkpoint and writes nothing');
    fs.rmSync(path.join(dir, 'target', 'import-checkpoint.json'));
    const fresh = await run('import', '--in', file, '--target', target);
    assert.deepEqual([fresh.code, fresh.output.created, fresh.output.unchanged], [0, 0, 4]);

    const compared = await run('compare', '--in', file, '--target', target);
    assert.equal(compared.code, 0, JSON.stringify(compared.output));
    assert.equal(compared.output.equal, 4);

    await store.updateDoc('user_organizations/u1', { organizations: [] });
    const report = path.join(dir, 'compare.json');
    const changed = await run('compare', '--in', file, '--target', target, '--report', report);
    assert.equal(changed.code, 1);
    assert.ok(JSON.parse(fs.readFileSync(report, 'utf8')).different.some(item => item.path === 'user_organizations/u1' && item.at === '/organizations/length'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a damaged export before importing anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-store-'));
  try {
    await sourceStore(path.join(dir, 'source'));
    const file = path.join(dir, 'store.ndjson');
    assert.equal((await run('export', '--source', `local:${path.join(dir, 'source')}`, '--out', file)).code, 0);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"Acme"', '"Acne"'));
    const verified = await run('verify', '--in', file);
    assert.equal(verified.code, 1);
    assert.deepEqual(verified.output.problems, ['collection organizations: checksum differs', 'file checksum differs']);
    const imported = await run('import', '--in', file, '--target', `local:${path.join(dir, 'target')}`);
    assert.equal(imported.code, 1);
    assert.equal(imported.output.stage, 'verify');
    assert.equal(fs.existsSync(path.join(dir, 'target')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects incomplete commands with usage', async () => {
  assert.equal((await run()).code, 2);
  assert.equal((await run('export', '--source', 'firestore')).code, 2);
  assert.equal((await run('import', '--in', 'x.ndjson', '--target', 'https://example.test')).code, 2);
  assert.equal((await run('verify', '--in', 'export.json')).code, 2);
  assert.equal((await run('launch')).code, 2);
});
