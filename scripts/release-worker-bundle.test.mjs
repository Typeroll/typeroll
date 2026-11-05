import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetNames, buildBundle, extractBundle, verifyBundle } from './release-worker-bundle.mjs';
import { gunzip, gzipDeterministic, moduleExports, packTar, readTar, workerContract } from './lib/worker-bundle.mjs';

const SHA = 'a'.repeat(40);
const digestOf = data => createHash('sha256').update(data).digest('hex');
const identity = { source_sha: SHA, lock_sha256: 'b'.repeat(64), node_version: '22.23.1', wrangler_version: '4.158.0', build_root: '/home/runner/work/typeroll/typeroll' };
const facts = { core_version: '0.3.0', data_schema_version: 2, data_schema_readable: { min: 2, max: 2 } };
const baseConfig = {
  name: 'typeroll-portal',
  main: 'entry.mjs',
  no_bundle: true,
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat'],
  rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
  assets: { binding: 'ASSETS', directory: '../client' },
  durable_objects: { bindings: [{ name: 'STORE', class_name: 'DocumentStore' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['DocumentStore'] }],
  triggers: { crons: ['*/5 * * * *'] },
  vars: { TYPEROLL_RUNTIME: 'workers', STORE_JURISDICTION: 'eu' },
  observability: { enabled: false, logs: { enabled: false }, traces: { enabled: false } },
  kv_namespaces: [],
  images: { binding: 'IMAGES' },
};

function fakeDist(t, config = baseConfig, entry = 'class DocumentStore {}\nexport { DocumentStore, worker_entry_default as default, OperatorApi };\n') {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (relative, body) => {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(path.join(dir, relative), body);
  };
  write('server/wrangler.json', JSON.stringify(config));
  write('server/entry.mjs', entry);
  write('server/chunks/a.mjs', 'export const a = 1;');
  write('server/.dev.vars', 'AUTH_SECRET=local-only');
  write('client/_astro/app.js', 'console.log(1)');
  write(`client/${'deep/'.repeat(30)}file.css`, 'body{}');
  return dir;
}

test('packing the same build output twice gives identical bytes, without local secrets', t => {
  const dist = fakeDist(t);
  const first = buildBundle({ distDirectory: dist, identity, facts });
  // File times and directory order are not inputs.
  utimesSync(path.join(dist, 'server/chunks/a.mjs'), new Date(2030, 1, 1), new Date(2030, 1, 1));
  const second = buildBundle({ distDirectory: dist, identity, facts });
  assert.ok(first.tarball.equals(second.tarball));
  assert.deepEqual(first.excluded, ['portal/server/.dev.vars']);
  const paths = readTar(gunzip(first.tarball)).map(file => file.path);
  assert.ok(!paths.some(file => file.includes('.dev.vars')));
  assert.ok(paths.includes('release.json') && paths.includes('portal/server/wrangler.json'));
  assert.equal(first.descriptor.asset, assetNames('0.3.0').tarball);
  assert.match(first.descriptor.sha256, /^sha256:[a-f0-9]{64}$/);
  // gzip header: no mtime, OS unknown.
  assert.equal(first.tarball.readUInt32LE(4), 0);
  assert.equal(first.tarball[9], 0xff);
});

test('the bundle records the release contract Cloud derives its configuration from', t => {
  const { descriptor } = buildBundle({ distDirectory: fakeDist(t), identity, facts });
  const portal = descriptor.release.workers.portal;
  assert.equal(descriptor.release.source_sha, SHA);
  assert.equal(descriptor.release.build.build_root, identity.build_root);
  assert.deepEqual(portal.durable_objects, [{ binding: 'STORE', class_name: 'DocumentStore' }]);
  assert.equal(portal.migration_tag, 'v1');
  assert.deepEqual(portal.exports, ['DocumentStore', 'OperatorApi', 'default']);
  assert.deepEqual(portal.crons, ['*/5 * * * *']);
  assert.deepEqual(descriptor.release.roles.forms, { worker: 'portal', vars: { SERVICE_ROLE: 'forms' }, store: 'portal' });
});

test('verification refuses substituted, added or rebound content', t => {
  const { tarball, descriptor } = buildBundle({ distDirectory: fakeDist(t), identity, facts });
  assert.equal(verifyBundle(tarball, descriptor, { source_sha: SHA, core_version: '0.3.0' }).core_version, '0.3.0');
  assert.throws(() => verifyBundle(tarball, descriptor, { source_sha: 'c'.repeat(40) }), /built from/);
  assert.throws(() => verifyBundle(tarball, descriptor, { core_version: '0.3.1' }), /not 0\.3\.1/);
  assert.throws(() => verifyBundle(tarball, { ...descriptor, sha256: `sha256:${'0'.repeat(64)}` }), /does not match the descriptor/);
  assert.throws(() => verifyBundle(tarball, descriptor, { sha256: `sha256:${'0'.repeat(64)}` }), /not the pinned/);

  // A repacked archive with one changed file and a matching descriptor digest
  // still fails: the embedded inventory pins every file.
  const files = readTar(gunzip(tarball)).map(file => file.path === 'portal/server/chunks/a.mjs' ? { ...file, data: Buffer.from('export const a = 2;') } : file);
  const forged = gzipDeterministic(packTar(files));
  const forgedDescriptor = { ...descriptor, size: forged.length, sha256: `sha256:${digestOf(forged)}` };
  assert.throws(() => verifyBundle(forged, forgedDescriptor), /do not match its release inventory/);
  const added = gzipDeterministic(packTar([...readTar(gunzip(tarball)), { path: 'portal/server/extra.mjs', data: Buffer.from('x') }]));
  assert.throws(() => verifyBundle(added, { ...descriptor, size: added.length, sha256: `sha256:${digestOf(added)}` }), /inventory/);
});

test('the EU and upload rules fail the release, not the deployment', () => {
  const contract = config => workerContract({ ...baseConfig, ...config }, { exports: ['DocumentStore', 'default'], directory: 'portal' }).errors.join('\n');
  assert.equal(contract({}), '');
  assert.match(contract({ observability: { enabled: true } }), /Logs and traces must be off/);
  assert.match(contract({ observability: { logs: { enabled: true } } }), /Logs and traces must be off/);
  assert.match(contract({ placement: { mode: 'smart' } }), /Smart Placement/);
  assert.match(contract({ kv_namespaces: [{ binding: 'SESSION', id: 'x' }] }), /KV namespaces are not allowed/);
  assert.match(contract({ vars: { STORE_JURISDICTION: 'none' } }), /STORE_JURISDICTION must be eu/);
  assert.match(contract({ migrations: [{ tag: 'v1', new_classes: ['DocumentStore'] }] }), /SQLite storage/);
  assert.match(contract({ migrations: [{ tag: 'v1', new_sqlite_classes: ['DocumentStore'] }, { tag: 'v1' }] }), /unique/);
  assert.match(contract({ migrations: [] }), /has no SQLite migration/);
  assert.match(contract({ no_bundle: false }), /without rebundling/);
  assert.match(workerContract(baseConfig, { exports: ['default'], directory: 'portal' }).errors.join('\n'), /not exported/);
});

test('a build output that breaks the contract or lacks the generated config is refused', t => {
  assert.throws(() => buildBundle({ distDirectory: fakeDist(t, { ...baseConfig, observability: { enabled: true } }), identity, facts }), /release contract/);
  assert.throws(() => buildBundle({ distDirectory: fakeDist(t, { ...baseConfig, assets: { binding: 'ASSETS', directory: '../elsewhere' } }), identity, facts }), /dist\/client/);
  assert.throws(() => buildBundle({ distDirectory: fakeDist(t, { ...baseConfig, main: 'missing.mjs' }), identity, facts }), /missing/);
  assert.throws(() => buildBundle({ distDirectory: fakeDist(t), identity: { ...identity, source_sha: 'main' }, facts }), /Git SHA/);
});

test('the tar reader accepts only safe regular files', () => {
  const ok = packTar([{ path: 'b/c.txt', data: Buffer.from('c') }, { path: 'a.txt', data: Buffer.from('a') }]);
  assert.deepEqual(readTar(ok).map(file => file.path), ['a.txt', 'b/c.txt']);
  assert.throws(() => packTar([{ path: '../x', data: Buffer.alloc(0) }]), /Unsafe/);
  assert.throws(() => packTar([{ path: '/etc/passwd', data: Buffer.alloc(0) }]), /Unsafe/);
  assert.throws(() => packTar([{ path: 'a', data: Buffer.alloc(0) }, { path: 'a', data: Buffer.alloc(0) }]), /Duplicate/);
  const link = Buffer.from(ok);
  link[156] = '2'.charCodeAt(0);
  let sum = 0;
  link.fill(0x20, 148, 156);
  for (let index = 0; index < 512; index += 1) sum += link[index];
  link.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  assert.throws(() => readTar(link), /Unsupported bundle entry type/);
  const corrupt = Buffer.from(ok);
  corrupt[0] ^= 1;
  assert.throws(() => readTar(corrupt), /checksum/);
  assert.throws(() => readTar(ok.subarray(0, 512)), /truncated|end-of-archive/);
});

test('module exports are read from the bundled entry', () => {
  assert.deepEqual(moduleExports('export { DocumentStore, worker_entry_default as default };'), ['DocumentStore', 'default']);
  assert.deepEqual(moduleExports('export class OperatorApi {}\nexport default { fetch() {} };'), ['OperatorApi', 'default']);
});

test('extraction stays inside the target directory', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-extract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  extractBundle(gzipDeterministic(packTar([{ path: 'portal/server/entry.mjs', data: Buffer.from('x') }])), dir);
  assert.throws(() => extractBundle(Buffer.from('not gzip'), dir));
});
