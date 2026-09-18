import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeStaticOutput, validateDirectReceipt, availablePagesAssets, retainPagesAssets, reusedMediaReceipt, mergeDirectReceipt } from '../packages/portal/src/lib/builds/direct-upload.mjs';

test('a thousand static files produce only a bounded receipt and preserve control files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-static-'));
  try {
    for (let i = 0; i < 1000; i++) await fs.writeFile(path.join(root, `asset-${i}.txt`), `fixture ${i}`);
    await fs.writeFile(path.join(root, '_headers'), '/*\n  X-Robots-Tag: noindex\n');
    const description = await describeStaticOutput(root);
    const manifest = Object.fromEntries(Object.keys(description.files).filter(name => name !== '_headers').map(name => ['/' + name, 'a'.repeat(32)]));
    const receipt = validateDirectReceipt({ format: 1, ...description, manifest });
    assert.equal(Object.keys(receipt.files).length, 1001);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 250000);
    assert.equal(Buffer.from(receipt.controls._headers, 'base64').toString(), '/*\n  X-Robots-Tag: noindex\n');
    const missing = structuredClone(receipt); delete missing.manifest['/asset-1.txt'];
    assert.throws(() => validateDirectReceipt(missing), /incomplete_direct_manifest/);
    const extra = structuredClone(receipt); extra.manifest['/unlisted.txt'] = 'a'.repeat(32);
    assert.throws(() => validateDirectReceipt(extra), /invalid_direct_manifest/);
    const altered = structuredClone(receipt); altered.controls._headers = Buffer.from('changed').toString('base64');
    assert.throws(() => validateDirectReceipt(altered), /invalid_direct_controls/);
    await fs.symlink(path.join(root, 'asset-1.txt'), path.join(root, 'symlink'));
    await assert.rejects(() => describeStaticOutput(root), /unsafe_build_output/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('direct manifests reject dynamic files, private paths and invalid hashes', () => {
  for (const name of ['../escape', '_worker.js', 'functions/index.js', '.env', '.typeroll-direct-upload.json']) {
    assert.throws(() => validateDirectReceipt({ format: 1, files: { [name]: { sha256: 'a'.repeat(64), size: 1 } }, controls: {}, manifest: { ['/' + name]: 'b'.repeat(32) } }));
  }
});

test('direct receipts accept bounded sites above the legacy artifact ceiling', () => {
  const files = {}, manifest = {};
  for (let i = 0; i < 20; i++) { const name = `document-${i}.pdf`; files[name] = { sha256: 'a'.repeat(64), size: 25 * 1024 * 1024 }; manifest['/' + name] = 'b'.repeat(32); }
  assert.equal(Object.keys(validateDirectReceipt({ format: 1, files, manifest, controls: {} }).files).length, 20);
  files.extra = { sha256: 'a'.repeat(64), size: 25 * 1024 * 1024 }; manifest['/extra'] = 'b'.repeat(32);
  assert.throws(() => validateDirectReceipt({ format: 1, files, manifest, controls: {} }), /build_output_limit/);
});

test('the trusted supervisor invokes the official project uploader with only the asset JWT', async () => {
  const source = await fs.readFile(new URL('../packages/portal/src/lib/builds/executor.mjs', import.meta.url), 'utf8');
  assert.match(source, /'pages', 'project', 'upload', dist/);
  // Wrangler's generic authentication gate needs its token variable as well;
  // both receive the same restricted asset JWT, never the customer's OAuth token.
  assert.match(source, /CF_PAGES_UPLOAD_JWT: grant\.jwt, CLOUDFLARE_API_TOKEN: grant\.jwt/);
});


test('Cloudflare installs the locked trusted uploader before claiming or qualifying work', async () => {
  const setup = await fs.readFile(new URL('../packages/portal/src/lib/builds/setup.ts', import.meta.url), 'utf8');
  const executor = await fs.readFile(new URL('../packages/portal/src/lib/builds/executor.mjs', import.meta.url), 'utf8');
  assert.match(setup, /build_command: 'npm ci --ignore-scripts --no-audit --no-fund && npm run build'/);
  assert.match(executor, /if \(job.kind === 'qualification'\) \{[\s\S]*?stage = 'uploader';[\s\S]*?'--version'/);
});

const target = { account: 'a'.repeat(32), project: 'one-site' };
const priorReceipt = () => ({ format: 1, target, files: { 'photo.png': { sha256: 'a'.repeat(64), size: 11 }, 'removed.png': { sha256: 'b'.repeat(64), size: 13 } },
  manifest: { '/photo.png': 'c'.repeat(32), '/removed.png': 'd'.repeat(32) }, controls: {} });

test('provider availability is scoped to the exact hosting target and fails back to downloads', async () => {
  const receipt = priorReceipt(), grant = { target, jwt: 'synthetic' };
  let calls = 0;
  const fetch = async (url, options) => {
    calls++; assert.equal(url, 'https://api.cloudflare.com/client/v4/pages/assets/check-missing');
    assert.equal(options.redirect, 'error'); assert.deepEqual(JSON.parse(options.body).hashes, ['c'.repeat(32), 'd'.repeat(32)]);
    return Response.json({ success: true, result: ['d'.repeat(32)] });
  };
  assert.deepEqual(await availablePagesAssets(receipt, grant, fetch), { 'photo.png': receipt.files['photo.png'] });
  assert.equal(calls, 1);
  for (const changed of [{ ...target, account: 'e'.repeat(32) }, { ...target, project: 'other' }])
    assert.deepEqual(await availablePagesAssets(receipt, { ...grant, target: changed }, fetch), {});
  assert.equal(calls, 1);
  for (const response of [() => new Response(null, { status: 503 }), () => Response.json({ success: true, result: ['unknown'] }), () => { throw Error('offline'); }])
    assert.deepEqual(await availablePagesAssets(receipt, grant, response), {});
});

test('reuse merges only current media and never resurrects a removed path or overwrites generated output', () => {
  const prior = priorReceipt(), prepared = [{ path: '/photo.png', reused: true, sha256: 'a'.repeat(64), size: 11 }];
  const reused = reusedMediaReceipt(prepared, prior);
  const local = { files: { 'index.html': { sha256: 'e'.repeat(64), size: 17 } }, controls: {} };
  const result = mergeDirectReceipt(local, { '/index.html': 'f'.repeat(32) }, reused, target);
  assert.deepEqual(Object.keys(result.files).sort(), ['index.html', 'photo.png']);
  assert.deepEqual(result.manifest, { '/index.html': 'f'.repeat(32), '/photo.png': 'c'.repeat(32) });
  assert.throws(() => mergeDirectReceipt({ ...local, files: { ...local.files, 'photo.png': prior.files['photo.png'] } }, result.manifest, reused, target), /collision/);
  for (const invalid of [{ ...prepared[0], sha256: 'e'.repeat(64) }, { ...prepared[0], size: 12 }, { ...prepared[0], path: '/../photo.png' }, { ...prepared[0], path: '/unlisted.png' }])
    assert.throws(() => reusedMediaReceipt([invalid], prior));
});

test('reused file paths cannot shadow generated directories', () => {
  const prior = priorReceipt(), reused = reusedMediaReceipt([{ path: '/photo.png', reused: true, sha256: 'a'.repeat(64), size: 11 }], prior);
  assert.throws(() => mergeDirectReceipt({ files: { 'photo.png/index.html': { sha256: 'e'.repeat(64), size: 1 } }, controls: {} }, { '/photo.png/index.html': 'f'.repeat(32) }, reused, target), /collision/);
});

test('refreshes reused asset hashes and bounds retries of optional indexing failures', async () => {
  let calls = 0;
  const receipt = priorReceipt();
  assert.equal(await retainPagesAssets(receipt, { jwt: 'synthetic' }, async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes');
    assert.deepEqual(JSON.parse(options.body).hashes, ['c'.repeat(32), 'd'.repeat(32)]);
    return ++calls === 1 ? new Response(null, { status: 503 }) : Response.json({ success: true });
  }), true);
  assert.equal(calls, 2); calls = 0;
  assert.equal(await retainPagesAssets(receipt, { jwt: 'synthetic' }, async () => { calls++; throw Error('offline'); }), false);
  assert.equal(calls, 2);
});
