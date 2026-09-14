import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { assertFilePath, MAX_ARTIFACT_BYTES } from './contract.mjs';

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
      if (stat.size > 25 * 1024 * 1024 || total > MAX_ARTIFACT_BYTES || Object.keys(files).length >= 20000) throw Error('build_output_limit');
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
  let total = 0;
  for (const [name, file] of Object.entries(value.files)) {
    assertFilePath(name, { artifact: true });
    if (name === DIRECT_RECEIPT || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 25 * 1024 * 1024) throw Error('invalid_direct_receipt');
    total += file.size;
    if (!['_headers', '_redirects'].includes(name) && !/^[a-f0-9]{32}$/.test(value.manifest['/' + name] ?? '')) throw Error('incomplete_direct_manifest');
  }
  if (total > MAX_ARTIFACT_BYTES) throw Error('build_output_limit');
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
