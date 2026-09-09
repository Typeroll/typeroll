import { createHash } from 'node:crypto';

export const BUILD_PROTOCOL = 1;
export const BUILD_RUNTIME = '22.23.1';
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

export function assertFilePath(name, { artifact = false } = {}) {
  if (typeof name !== 'string' || name.length > 1024 || /[\\\x00-\x1f\x7f?#%:]/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..' || ['.git', 'node_modules'].includes(part))) throw Error('Invalid build file path');
  if (artifact && name.split('/').some(part => (['_worker.js', '_worker.js.map', 'functions', '.npmrc'].includes(part) || part === '.env' || part.startsWith('.env.')))) throw Error('Dynamic or private files are not static output');
}

export function assertBuildIdentity(value) {
  if (!value || value.protocol !== BUILD_PROTOCOL || !['org_id', 'site_id', 'version_id', 'job_id'].every(key => identity(value[key])) ||
      !hash(value.publication_id) || !hash(value.source_sha256) || !/^[a-f0-9]{40}$/.test(value.commit ?? '') ||
      !/^main$|^version-[a-z0-9][a-z0-9-]{0,127}$/.test(value.branch ?? '') || value.node_version !== BUILD_RUNTIME) throw Error('Unsupported frozen build identity');
  return value;
}

export function encodeSource(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length || Object.keys(files).length > 10000) throw Error('Invalid build source');
  for (const [name, text] of Object.entries(files)) { assertFilePath(name); if (typeof text !== 'string') throw Error('Build source must contain text files'); }
  const bytes = Buffer.from(JSON.stringify({ protocol: BUILD_PROTOCOL, files }));
  if (bytes.length > MAX_SOURCE_BYTES) throw Error('Build source exceeds the size limit');
  return bytes;
}

export function decodeSource(bytes, expectedHash) {
  if (bytes.length > MAX_SOURCE_BYTES || !hash(expectedHash) || sha256(bytes) !== expectedHash) throw Error('Build source integrity mismatch');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.protocol !== BUILD_PROTOCOL) throw Error('Unsupported build source protocol');
  encodeSource(value.files);
  return value.files;
}

export function encodeArtifact(identity, files) {
  assertBuildIdentity(identity);
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length || entries.length > 20000) throw Error('Invalid static output file count');
  let total = 0;
  const output = entries.map(([name, bytes]) => {
    assertFilePath(name, { artifact: true });
    if (!(bytes instanceof Uint8Array) || bytes.length > 25 * 1024 * 1024) throw Error('Invalid static output file');
    total += bytes.length;
    if (total > MAX_ARTIFACT_BYTES) throw Error('Static output exceeds the size limit');
    return { name, sha256: sha256(bytes), data: Buffer.from(bytes).toString('base64') };
  });
  const bytes = Buffer.from(JSON.stringify({ protocol: BUILD_PROTOCOL, identity, files: output }));
  if (bytes.length > MAX_ARTIFACT_BYTES) throw Error('Static artifact exceeds the size limit');
  return bytes;
}

/** Validate bytes independently before deployment; a matching marker alone is insufficient. */
export function decodeArtifact(bytes, expectedIdentity, expectedHash) {
  assertBuildIdentity(expectedIdentity);
  if (bytes.length > MAX_ARTIFACT_BYTES || !hash(expectedHash) || sha256(bytes) !== expectedHash) throw Error('Static artifact integrity mismatch');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.protocol !== BUILD_PROTOCOL || Object.keys(expectedIdentity).some(key => value.identity?.[key] !== expectedIdentity[key]) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > 20000) throw Error('Static artifact identity mismatch');
  const files = Object.create(null);
  for (const entry of value.files) {
    assertFilePath(entry.name, { artifact: true });
    if (Object.hasOwn(files, entry.name) || typeof entry.data !== 'string') throw Error('Duplicate or invalid static output');
    const data = Buffer.from(entry.data, 'base64');
    if (data.toString('base64') !== entry.data || data.length > 25 * 1024 * 1024 || sha256(data) !== entry.sha256) throw Error('Static output integrity mismatch');
    files[entry.name] = data;
  }
  const marker = JSON.parse(files['.well-known/typeroll/publication.json']?.toString('utf8') ?? 'null');
  if (marker?.id !== expectedIdentity.publication_id) throw Error('Static publication marker mismatch');
  return files;
}
