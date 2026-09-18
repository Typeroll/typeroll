import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { assertFilePath } from './contract.mjs';

export const MAX_DIRECT_OUTPUT_BYTES = 512 * 1024 * 1024;
export const DIRECT_RECEIPT = '.typeroll-direct-upload.json';
/** The supervisor reads bounded metadata. Site bytes remain in the customer's build environment. */
export async function describeStaticOutput(root) {
  const files = Object.create(null), controls = Object.create(null); let total = 0;
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name; assertFilePath(name, { artifact: true });
      if (name === DIRECT_RECEIPT) throw Error('reserved_build_output');
      const target = path.join(dir, entry.name), stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.isFile() && stat.nlink !== 1) throw Error('unsafe_build_output');
      if (stat.isDirectory()) { await walk(target, name + '/'); continue; }
      total += stat.size;
      if (stat.size > 25 * 1024 * 1024 || total > MAX_DIRECT_OUTPUT_BYTES || Object.keys(files).length >= 20000) throw Error('build_output_limit');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(target)) digest.update(chunk);
      files[name] = { sha256: digest.digest('hex'), size: stat.size };
      if (['_headers', '_redirects'].includes(name)) {
        if (stat.size > 128 * 1024) throw Error('static_control_file_limit');
        controls[name] = (await fs.readFile(target)).toString('base64');
      }
    }
  }
  await walk(root); return { files, controls };
}
/** Accept only a small, complete receipt for static files and the official uploader's content hashes. */
export function validateDirectReceipt(value) {
  if (value?.format !== 1 || !value.files || !value.manifest || !value.controls ||
      Object.keys(value.files).length < 1 || Object.keys(value.files).length > 20000) throw Error('invalid_direct_receipt');
  if (value.target && (!/^[a-f0-9]{32}$/.test(value.target.account ?? '') || !/^[a-z0-9-]{1,58}$/.test(value.target.project ?? ''))) throw Error('invalid_direct_target');
  let total = 0;
  for (const [name, file] of Object.entries(value.files)) {
    assertFilePath(name, { artifact: true });
    if (name === DIRECT_RECEIPT || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 25 * 1024 * 1024) throw Error('invalid_direct_receipt');
    total += file.size;
    if (!['_headers', '_redirects'].includes(name) && !/^[a-f0-9]{32}$/.test(value.manifest['/' + name] ?? '')) throw Error('incomplete_direct_manifest');
  }
  if (total > MAX_DIRECT_OUTPUT_BYTES) throw Error('build_output_limit');
  for (const [route, hash] of Object.entries(value.manifest)) {
    if (!route.startsWith('/') || !value.files[route.slice(1)] || ['/_headers', '/_redirects'].includes(route) || !/^[a-f0-9]{32}$/.test(hash)) throw Error('invalid_direct_manifest');
  }
  for (const [name, encoded] of Object.entries(value.controls)) {
    if (!['_headers', '_redirects'].includes(name) || typeof encoded !== 'string' || encoded.length > 180000) throw Error('invalid_direct_controls');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length !== value.files[name]?.size || createHash('sha256').update(bytes).digest('hex') !== value.files[name]?.sha256) throw Error('invalid_direct_controls');
  }
  for (const name of ['_headers', '_redirects']) if (value.files[name] && !(name in value.controls)) throw Error('missing_direct_controls');
  return value;
}

/** Ask the same asset availability endpoint used by the pinned official uploader.
 * Failure is a cache miss, never permission to omit bytes from an upload. */
export async function availablePagesAssets(receipt, grant, fetchImpl = fetch) {
  try {
    validateDirectReceipt(receipt);
    if (!receipt.target || receipt.target.account !== grant.target?.account || receipt.target.project !== grant.target?.project) return {};
    if (typeof grant.jwt !== 'string' || !grant.jwt || grant.jwt.length > 16384) return {};
    const hashes = [...new Set(Object.values(receipt.manifest))], missing = new Set();
    for (let offset = 0; offset < hashes.length; offset += 5000) {
      const batch = hashes.slice(offset, offset + 5000);
      const response = await fetchImpl('https://api.cloudflare.com/client/v4/pages/assets/check-missing', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${grant.jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: batch }),
      });
      if (!response.ok) { await response.body?.cancel(); return {}; }
      const result = await response.json();
      if (result.success !== true || !Array.isArray(result.result) || result.result.some(hash => !batch.includes(hash))) return {};
      for (const hash of result.result) missing.add(hash);
    }
    return Object.fromEntries(Object.entries(receipt.files).filter(([name]) => receipt.manifest['/' + name] && !missing.has(receipt.manifest['/' + name])));
  } catch { return {}; }
}

/** Only current media descriptors may reuse a prior output. Never carry old routes forward. */
export function reusedMediaReceipt(preparedFiles, previous) {
  const files = Object.create(null), manifest = Object.create(null);
  for (const file of preparedFiles) {
    if (!file.reused) continue;
    if (typeof file.path !== 'string' || !file.path.startsWith('/')) throw Error('invalid_reused_media');
    const name = file.path.slice(1); assertFilePath(name, { artifact: true });
    const prior = previous?.files[name], hash = previous?.manifest[file.path];
    if (!prior || prior.sha256 !== file.sha256 || prior.size !== file.size || !/^[a-f0-9]{32}$/.test(hash ?? '') || ['_headers', '_redirects'].includes(name)) throw Error('invalid_reused_media');
    files[name] = prior; manifest[file.path] = hash;
  }
  return { files, manifest, controls: {}, format: 1, target: previous?.target };
}

export function mergeDirectReceipt(description, manifest, reused, target) {
  for (const name of Object.keys(reused.files)) if (Object.hasOwn(description.files, name)) throw Error('media_output_collision');
  const names = new Set([...Object.keys(description.files), ...Object.keys(reused.files)]);
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) throw Error('media_output_collision');
  }
  return validateDirectReceipt({ format: 1, target, files: { ...description.files, ...reused.files },
    controls: description.controls, manifest: { ...manifest, ...reused.manifest } });
}

/** Refresh availability metadata, as Wrangler does for both uploaded and skipped files. */
export async function retainPagesAssets(receipt, grant, fetchImpl = fetch) {
  const hashes = [...new Set(Object.values(receipt.manifest))];
  for (let offset = 0; offset < hashes.length; offset += 5000) {
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        const response = await fetchImpl('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${grant.jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: hashes.slice(offset, offset + 5000) }),
        });
        if (response.ok) saved = (await response.json()).success === true;
        else await response.body?.cancel();
      } catch { /* This optional index improves the next upload, not current content. */ }
    }
    if (!saved) return false;
  }
  return true;
}
