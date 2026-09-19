import { createHash } from 'node:crypto';

export const BUILD_PROTOCOL = 1;
export const BUILD_RUNTIME = '22.23.1';
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_RENDER_CACHE_BYTES = 32 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const ARTIFACT_MAGIC = Buffer.from('TYPEROLL-ARTIFACT-2\n');

export const SEO_VALIDATOR_VERSION = 1;
export const MAX_SEO_REPORT_CHARACTERS = 250000;
// At most three UTF-8 bytes per UTF-16 code unit, plus the small attempt envelope.
export const MAX_SEO_REPORT_BYTES = 3 * MAX_SEO_REPORT_CHARACTERS;
export const MAX_RUNNER_RESULT_BYTES = MAX_SEO_REPORT_BYTES + 8192;
export const outputDigest = files => sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, f]) => [name, f.sha256, f.size])));
/** Reports are bounded public diagnostics, bound to this attempt and its bytes. */
export function seoReport(value, publicationId) {
  if (!value || value.version !== SEO_VALIDATOR_VERSION || value.publication_id !== publicationId ||
      !['source_sha256', 'configuration_sha256', 'artifact_tree_sha256'].every(k => hash(value[k])) ||
      typeof value.passed !== 'boolean' || !['checked_pages', 'error_count', 'warning_count'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0) ||
      value.passed !== (value.error_count === 0) || !Array.isArray(value.errors) || !Array.isArray(value.warnings) ||
      value.errors.length > Math.min(100, value.error_count) || value.warnings.length > Math.min(100, value.warning_count) || value.error_count > 0 && value.errors.length === 0 || JSON.stringify(value).length > MAX_SEO_REPORT_CHARACTERS) throw Error('publication_validation_report_invalid');
  const issue = item => {
    if (!item || !/^[a-z_]{1,80}$/.test(item.code) || !item.source || typeof item.source !== 'object') throw Error('publication_validation_report_invalid');
    const bounded = (v, max = 2048) => { if (typeof v !== 'string' || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)) throw Error('publication_validation_report_invalid'); return v; };
    const source = { file: bounded(item.source.file), line: item.source.line };
    if (!Number.isSafeInteger(source.line) || source.line < 1) throw Error('publication_validation_report_invalid');
    for (const k of ['element', 'block_id', 'page_id', 'field']) if (item.source[k] !== undefined) source[k] = bounded(item.source[k]);
    return { code: item.code, url: bounded(item.url), source, message: bounded(item.message, 4096), remediation: bounded(item.remediation, 4096) };
  };
  return { version: value.version, publication_id: publicationId, source_sha256: value.source_sha256, configuration_sha256: value.configuration_sha256,
    artifact_tree_sha256: value.artifact_tree_sha256, checked_pages: value.checked_pages, passed: value.passed,
    error_count: value.error_count, warning_count: value.warning_count, errors: value.errors.map(issue), warnings: value.warnings.map(issue) };
}

export function renderReport(value) {
  if (!value || value.format !== 1 || !['full', 'partial'].includes(value.mode)
    || !['rendered', 'reused', 'total', 'removed'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 20000)
    || value.rendered + value.reused !== value.total || (value.mode === 'partial') !== (value.reused > 0)
    || !['forced_full', 'no_valid_cache', 'unchanged_routes_reused', 'dependencies_changed'].includes(value.reason)) return undefined;
  return Object.fromEntries(['format', 'mode', 'rendered', 'reused', 'total', 'removed', 'reason'].map(key => [key, value[key]]));
}

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
    return { name, sha256: sha256(bytes), size_bytes: bytes.length };
  });
  // Binary framing avoids base64 expanding a valid static site beyond its budget.
  // Both transport size and decoded file bytes retain the existing 128 MiB cap.
  const manifest = Buffer.from(JSON.stringify({ protocol: 2, identity, files: output }));
  const size = ARTIFACT_MAGIC.length + 4 + manifest.length + total;
  if (size > MAX_ARTIFACT_BYTES) throw Error('Static artifact exceeds the size limit');
  const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
  return Buffer.concat([ARTIFACT_MAGIC, length, manifest, ...entries.map(([, bytes]) => bytes)], size);
}

/** Validate bytes independently before deployment; a matching marker alone is insufficient. */
export function decodeArtifact(bytes, expectedIdentity, expectedHash) {
  assertBuildIdentity(expectedIdentity);
  if (bytes.length > MAX_ARTIFACT_BYTES || !hash(expectedHash) || sha256(bytes) !== expectedHash) throw Error('Static artifact integrity mismatch');
  const binary = bytes.subarray(0, ARTIFACT_MAGIC.length).equals(ARTIFACT_MAGIC);
  let offset = 0, value;
  if (binary) {
    if (bytes.length < ARTIFACT_MAGIC.length + 4) throw Error('Static artifact integrity mismatch');
    const length = bytes.readUInt32BE(ARTIFACT_MAGIC.length);
    offset = ARTIFACT_MAGIC.length + 4 + length;
    if (!length || offset > bytes.length) throw Error('Static artifact integrity mismatch');
    value = JSON.parse(bytes.subarray(ARTIFACT_MAGIC.length + 4, offset).toString('utf8'));
  } else value = JSON.parse(bytes.toString('utf8')); // Previously issued JSON artifacts remain readable.
  if (value.protocol !== (binary ? 2 : BUILD_PROTOCOL) || Object.keys(expectedIdentity).some(key => value.identity?.[key] !== expectedIdentity[key]) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > 20000) throw Error('Static artifact identity mismatch');
  const files = Object.create(null);
  let total = 0;
  for (const entry of value.files) {
    assertFilePath(entry.name, { artifact: true });
    if (Object.hasOwn(files, entry.name)) throw Error('Duplicate or invalid static output');
    let data;
    if (binary) {
      if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 || entry.size_bytes > 25 * 1024 * 1024 || offset + entry.size_bytes > bytes.length) throw Error('Static output integrity mismatch');
      data = bytes.subarray(offset, offset + entry.size_bytes); offset += entry.size_bytes;
    } else {
      if (typeof entry.data !== 'string') throw Error('Duplicate or invalid static output');
      data = Buffer.from(entry.data, 'base64');
      if (data.toString('base64') !== entry.data) throw Error('Static output integrity mismatch');
    }
    total += data.length;
    if (total > MAX_ARTIFACT_BYTES || data.length > 25 * 1024 * 1024 || sha256(data) !== entry.sha256) throw Error('Static output integrity mismatch');
    files[entry.name] = data;
  }
  if (binary && offset !== bytes.length) throw Error('Static artifact integrity mismatch');
  const marker = JSON.parse(files['.well-known/typeroll/publication.json']?.toString('utf8') ?? 'null');
  if (marker?.id !== expectedIdentity.publication_id) throw Error('Static publication marker mismatch');
  return files;
}
