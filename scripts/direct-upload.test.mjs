import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeStaticOutput, validateDirectReceipt } from '../packages/portal/src/lib/builds/direct-upload.mjs';

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
