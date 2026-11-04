import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeStaticOutput, outputMeasure, planUploadChunks, withUploadChunk, validateDirectReceipt, availablePagesAssets, retainPagesAssets, reusedMediaReceipt, mergeDirectReceipt } from '../packages/portal/src/lib/builds/direct-upload.mjs';

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

test('direct receipts have no total size cap, only the Pages file count and file size limits', () => {
  const files = {}, manifest = {};
  // 40 files of 25 MiB is 1 GiB, above the former 512 MiB cap.
  for (let i = 0; i < 40; i++) { const name = `document-${i}.pdf`; files[name] = { sha256: 'a'.repeat(64), size: 25 * 1024 * 1024 }; manifest['/' + name] = 'b'.repeat(32); }
  assert.equal(Object.keys(validateDirectReceipt({ format: 1, files, manifest, controls: {} }).files).length, 40);
  const oversized = { ...files, large: { sha256: 'a'.repeat(64), size: 25 * 1024 * 1024 + 1 } };
  assert.throws(() => validateDirectReceipt({ format: 1, files: oversized, manifest: { ...manifest, '/large': 'b'.repeat(32) }, controls: {} }), /invalid_direct_receipt/);
});

test('large outputs are split into bounded upload runs without the control files', () => {
  const files = { _headers: { size: 10 }, _redirects: { size: 10 } };
  for (let i = 0; i < 7; i++) files[`media/${i}.png`] = { size: 100 };
  files['index.html'] = { size: 50 };
  const chunks = planUploadChunks(files, { maxBytes: 250, maxFiles: 10 });
  assert.deepEqual(chunks, [['index.html', 'media/0.png', 'media/1.png'], ['media/2.png', 'media/3.png'], ['media/4.png', 'media/5.png'], ['media/6.png']]);
  assert.deepEqual(planUploadChunks(files, { maxBytes: 1e9, maxFiles: 3 }).map(chunk => chunk.length), [3, 3, 2]);
  // A single file larger than the run budget still gets its own run.
  assert.deepEqual(planUploadChunks({ 'big.pdf': { size: 500 } }, { maxBytes: 100 }), [['big.pdf']]);
  assert.deepEqual(planUploadChunks({ _headers: { size: 1 } }), []);
});

test('an upload run sees only its files, and every file returns afterwards even on failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-chunk-'));
  try {
    await fs.mkdir(path.join(root, 'media'));
    for (const name of ['index.html', 'media/a.png', 'media/b.png']) await fs.writeFile(path.join(root, name), name);
    const listed = await withUploadChunk(root, path.join(root, '..', path.basename(root) + '-run'), ['media/a.png', 'index.html'], async directory => {
      const names = []; for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) if (entry.isFile()) names.push(path.relative(directory, path.join(entry.parentPath ?? entry.path, entry.name)));
      return names.sort();
    });
    assert.deepEqual(listed, ['index.html', 'media/a.png']);
    await assert.rejects(() => withUploadChunk(root, path.join(root, '..', path.basename(root) + '-fail'), ['media/b.png'], async () => { throw Error('uploader failed'); }), /uploader failed/);
    for (const name of ['index.html', 'media/a.png', 'media/b.png']) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), name);
    await assert.rejects(() => fs.access(path.join(root, '..', path.basename(root) + '-fail')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the trusted supervisor invokes the official project uploader with only the asset JWT', async () => {
  const source = await fs.readFile(new URL('../packages/portal/src/lib/builds/executor.mjs', import.meta.url), 'utf8');
  assert.match(source, /'pages', 'project', 'upload', directory/);
  assert.match(source, /planUploadChunks\(description\.files\)/);
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

test('large valid redirects survive description and receipt validation above 128 KiB', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'large-redirects-'));
  try {
    const redirects = Array.from({ length: 936 }, (_, i) => `/old/${'a'.repeat(150)}${i}.jpg /new/${i}.jpg 301\n`).join('');
    await fs.writeFile(path.join(root, '_redirects'), redirects);
    const description = await describeStaticOutput(root);
    const receipt = validateDirectReceipt({ format: 1, ...description, manifest: {} });
    assert.equal(Buffer.from(receipt.controls._redirects, 'base64').toString(), redirects);
    await fs.writeFile(path.join(root, '_headers'), 'x'.repeat(128 * 1024 + 1));
    await assert.rejects(() => describeStaticOutput(root), /static_control_file_limit/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a refused static output names the exceeded limit, its totals and the largest files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-limit-'));
  const logged = [], log = console.log; console.log = line => logged.push(String(line));
  try {
    await fs.mkdir(path.join(root, 'media'));
    for (let i = 0; i < 12; i++) await fs.writeFile(path.join(root, 'media', `illustration-${i}.png`), Buffer.alloc(1000 + i));
    await fs.writeFile(path.join(root, 'index.html'), '<p>home</p>');
    await assert.rejects(() => describeStaticOutput(root, { bytes: 5000, files: 100, file_bytes: 25 * 1024 * 1024 }), /build_output_limit/);
    const line = logged.find(value => value.startsWith('TYPEROLL_OUTPUT_LIMIT '));
    const report = JSON.parse(line.slice('TYPEROLL_OUTPUT_LIMIT '.length));
    assert.equal(report.limit, 'bytes'); assert.equal(report.max, 5000); assert.equal(report.files, 13);
    assert.equal(report.largest.length, 10); assert.deepEqual(report.largest[0], { name: 'media/illustration-11.png', size: 1011 });
    assert.equal(Object.keys(report.folders)[0], 'media');
    // Within the limits the same output is described normally.
    console.log = log;
    assert.equal(Object.keys((await describeStaticOutput(root)).files).length, 13);
  } finally { console.log = log; await fs.rm(root, { recursive: true, force: true }); }
});

test('an oversized file is named before the total, and memory stays bounded by the file limit', () => {
  const measure = outputMeasure({ bytes: 10, files: 2, file_bytes: 4 });
  for (const [name, size] of [['a', 1], ['big/b', 5], ['c', 1]]) measure.add(name, size);
  assert.deepEqual(measure.exceeded(), { limit: 'file_bytes', max: 4, files: 3, bytes: 7, largest: [{ name: 'big/b', size: 5 }, { name: 'a', size: 1 }, { name: 'c', size: 1 }], folders: { big: 5, '(root)': 2 } });
  const counted = outputMeasure({ bytes: 100, files: 2, file_bytes: 4 });
  for (const name of ['a', 'b', 'c']) counted.add(name, 1);
  assert.equal(counted.exceeded().limit, 'files');
  assert.equal(outputMeasure().exceeded(), null);
});
