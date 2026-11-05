// The Core Worker release bundle: the exact `@astrojs/cloudflare` build output,
// packed as a reproducible tarball with an embedded release contract.
//
// Reproducible means: the same build output packs to the same bytes. Entries
// are sorted, every header has mode 0644, uid/gid 0, empty owner names and
// mtime 0, and the gzip header carries no timestamp or OS. The digest Cloud
// pins is the SHA-256 of the published `.tar.gz`; `content_sha256` hashes the
// file inventory, so a rebuild can be compared even with another zlib.
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const BUNDLE_KIND = 'typeroll-core-workers';
export const BUNDLE_SCHEMA_VERSION = 1;
export const RELEASE_FILE = 'release.json';
// Local secrets and environment files never travel in a release, even when a
// developer build left them in the output directory (the Cloudflare Vite
// plugin copies `.dev.vars` next to the generated wrangler.json).
const EXCLUDED = [/^\.dev\.vars(\..+)?$/, /^\.env(\..+)?$/];
const BLOCK = 512;

export const sha256 = value => createHash('sha256').update(value).digest('hex');

function octal(value, width) {
  const text = value.toString(8);
  if (text.length > width - 1) throw Error(`Tar field overflow: ${value}`);
  return text.padStart(width - 1, '0') + '\0';
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index), rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw Error(`Path too long for a ustar entry: ${name}`);
}

function header(name, size) {
  const block = Buffer.alloc(BLOCK);
  const split = splitName(name);
  block.write(split.name, 0, 100, 'utf8');
  block.write(octal(0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.fill(0x20, 148, 156);
  block.write('0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write(split.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

function safePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw Error(`Unsafe bundle path: ${name}`);
  }
  return name;
}

/** Files as `{ path, data }`; the output does not depend on input order. */
export function packTar(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  let previous;
  for (const file of sorted) {
    safePath(file.path);
    if (file.path === previous) throw Error(`Duplicate bundle path: ${file.path}`);
    previous = file.path;
    chunks.push(header(file.path, file.data.length), file.data);
    const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

/** Regular files only; links, devices, PAX headers and unsafe paths are refused. */
export function readTar(buffer) {
  const files = [];
  const seen = new Set();
  for (let offset = 0; offset + BLOCK <= buffer.length;) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (block.every(byte => byte === 0)) return files;
    const stored = parseInt(block.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index];
    if (sum !== stored) throw Error('Corrupt bundle: tar header checksum mismatch');
    const type = String.fromCharCode(block[156] || 0x30);
    const field = (start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    if (type !== '0') throw Error(`Unsupported bundle entry type ${JSON.stringify(type)} for ${name}`);
    const size = parseInt(field(124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0) throw Error(`Corrupt bundle: invalid size for ${name}`);
    safePath(name);
    if (seen.has(name)) throw Error(`Duplicate bundle path: ${name}`);
    seen.add(name);
    const start = offset + BLOCK;
    if (start + size > buffer.length) throw Error(`Corrupt bundle: ${name} is truncated`);
    files.push({ path: name, data: buffer.subarray(start, start + size) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw Error('Corrupt bundle: missing end-of-archive marker');
}

/** gzip without a timestamp (node writes 0) and with OS "unknown", so the header is platform-independent. */
export function gzipDeterministic(tar) {
  const gz = gzipSync(tar, { level: 9 });
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[3] !== 0 || gz.readUInt32LE(4) !== 0) throw Error('Unexpected gzip header');
  gz[9] = 0xff;
  return gz;
}

export const gunzip = buffer => gunzipSync(buffer);

/** Every regular file under `directory`, sorted, as `{ path, data }` with a prefix. */
export function collectFiles(directory, prefix, excluded = []) {
  const walk = relative => readdirSync(path.join(directory, relative)).sort().flatMap(name => {
    const childRelative = relative ? `${relative}/${name}` : name;
    const file = path.join(directory, childRelative);
    const stat = lstatSync(file);
    if (EXCLUDED.some(pattern => pattern.test(name))) {
      excluded.push(`${prefix}/${childRelative}`);
      return [];
    }
    if (stat.isSymbolicLink()) throw Error(`Symbolic link in build output: ${prefix}/${childRelative}`);
    if (stat.isDirectory()) return walk(childRelative);
    if (!stat.isFile()) throw Error(`Unsupported build output entry: ${prefix}/${childRelative}`);
    return [{ path: `${prefix}/${childRelative}`, data: readFileSync(file) }];
  });
  return walk('');
}

export const inventoryOf = files => files
  .map(file => [file.path, sha256(file.data), file.data.length])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
export const contentDigest = inventory => sha256(JSON.stringify(inventory));

/** Names a bundled ES module exports (`export { a as b }`, `export class X`, ...). */
export function moduleExports(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name.replace(/^["']|["']$/g, ''));
    }
  }
  for (const match of source.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  if (/export\s+default\b/.test(source)) names.add('default');
  return [...names].sort();
}

const isEnabled = value => value === true || value?.enabled === true;

/**
 * The release contract of one Worker build output: what Cloud must bind and
 * may not change. Violations of the EU isolation rules fail the release.
 */
export function workerContract(config, { exports, directory }) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(config.no_bundle === true, 'the build output must be uploaded without rebundling (no_bundle: true)');
  check(typeof config.main === 'string' && !config.main.includes('..'), 'main must name a module inside the server output');
  check(/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date ?? ''), 'compatibility_date is required');
  const observability = config.observability ?? {};
  check(!isEnabled(observability) && !isEnabled(observability.logs) && !isEnabled(observability.traces),
    'Workers Logs and traces must be off (logs leave through Logpush to EU R2)');
  check(!config.placement || config.placement.mode === 'off', 'Smart Placement must be off');
  check(!(config.kv_namespaces ?? []).length, 'KV namespaces are not allowed: KV caches copies outside the EU');
  check(!config.vars?.STORE_JURISDICTION || config.vars.STORE_JURISDICTION === 'eu', 'STORE_JURISDICTION must be eu');
  check(!config.exports || !Object.keys(config.exports).length, 'declarative Durable Object exports are not supported; use migrations');

  const migrations = config.migrations ?? [];
  const tags = migrations.map(migration => migration.tag);
  check(tags.every(tag => typeof tag === 'string' && tag) && new Set(tags).size === tags.length, 'Durable Object migration tags must be unique and non-empty');
  check(migrations.every(migration => !(migration.new_classes ?? []).length), 'Durable Objects must use SQLite storage (new_sqlite_classes)');
  const created = new Set(migrations.flatMap(migration => [
    ...(migration.new_sqlite_classes ?? []),
    ...(migration.renamed_classes ?? []).map(rename => rename.to),
  ]));
  for (const migration of migrations) {
    for (const deleted of migration.deleted_classes ?? []) created.delete(deleted);
    for (const rename of migration.renamed_classes ?? []) created.delete(rename.from);
  }
  const durableObjects = (config.durable_objects?.bindings ?? []).map(binding => ({ binding: binding.name, class_name: binding.class_name, ...(binding.script_name ? { script_name: binding.script_name } : {}) }));
  for (const binding of durableObjects.filter(item => !item.script_name)) {
    check(created.has(binding.class_name), `Durable Object class ${binding.class_name} has no SQLite migration`);
    check(exports.includes(binding.class_name), `Durable Object class ${binding.class_name} is not exported by ${config.main}`);
  }
  check(!config.assets || (typeof config.assets.directory === 'string' && config.assets.binding), 'assets need a binding and a directory');

  return {
    errors,
    contract: {
      directory,
      main: config.main,
      compatibility_date: config.compatibility_date,
      compatibility_flags: [...(config.compatibility_flags ?? [])].sort(),
      exports,
      durable_objects: durableObjects,
      migrations,
      migration_tag: tags.at(-1) ?? null,
      crons: [...(config.triggers?.crons ?? [])],
      bindings: {
        assets: config.assets?.binding ?? null,
        images: config.images?.binding ?? null,
        r2_buckets: (config.r2_buckets ?? []).map(bucket => bucket.binding).sort(),
        services: (config.services ?? []).map(service => service.binding).sort(),
      },
      vars: Object.keys(config.vars ?? {}).sort(),
      secrets_required: [...(config.secrets?.required ?? [])].sort(),
    },
  };
}
