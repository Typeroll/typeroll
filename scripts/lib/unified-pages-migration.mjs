import { isDeepStrictEqual } from 'node:util';
import { SELF_HOST_INSTALLATION_PATH } from './self-host-schema.mjs';
import { loadUnifiedPagesMigration } from './unified-pages-loader.mjs';

function assertJson(value, documentPath) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertJson(item, documentPath); return; }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) assertJson(item, documentPath);
    return;
  }
  throw new Error(`Non-JSON content requires migration review at ${documentPath}`);
}

/** Plan every site before changing any site. Auth and media bytes stay put. */
export async function prepareUnifiedPagesMigration({ verifiedBackup, types = {} }) {
  if (verifiedBackup?.manifest?.data_schema_version !== 1 || !verifiedBackup.readDocuments) throw new Error('A verified schema 1 backup is required');
  const engine = await loadUnifiedPagesMigration();
  const source = new Map();
  for await (const record of verifiedBackup.readDocuments(types)) {
    if (record.path !== SELF_HOST_INSTALLATION_PATH) source.set(record.path, record.data);
  }
  const result = new Map(source);
  const sites = new Map();
  for (const [documentPath, raw] of source) {
    const match = documentPath.match(/^(organizations\/[^/]+\/sites\/[^/]+)(?:\/(.*))?$/);
    if (match) {
      const documents = sites.get(match[1]) ?? {};
      if (match[2]) {
        const data = engine.decodeNestedArrays(raw);
        assertJson(data, documentPath);
        documents[match[2]] = data;
      }
      sites.set(match[1], documents);
    }
    if (/\/workflows\/[^/]+$/.test(documentPath) && !['completed', 'failed', 'cancelled'].includes(raw.status)) {
      throw new Error(`Finish or cancel the active workflow before taking the migration backup: ${documentPath}`);
    }
    if (/\/deploys\/[^/]+$/.test(documentPath) && ['queued', 'pending', 'building', 'deploying', 'running', 'distributing'].includes(raw.status)) {
      throw new Error(`Finish or cancel the active publication before taking the migration backup: ${documentPath}`);
    }
    // Mutable grants change namespace. Signed extension manifests and audit
    // records remain historical; extensions must publish a native manifest.
    if (/^(?:api_key_lookup\/[^/]+|organizations\/[^/]+\/(?:api_keys|extensions)\/[^/]+)$/.test(documentPath)) {
      const data = { ...raw };
      for (const field of ['scopes', 'granted_scopes']) if (Array.isArray(data[field])) {
        data[field] = [...new Set(data[field].map(scope => typeof scope === 'string' ? scope.replace(/^collections:(read|write)$/, 'content:$1') : scope))];
      }
      result.set(documentPath, data);
    }
  }
  const reports = [];
  for (const [sitePath, documents] of [...sites].sort(([a], [b]) => a.localeCompare(b))) {
    const plan = engine.planUnifiedSiteMigration(documents, verifiedBackup.manifest.created_at);
    for (const relative of Object.keys(documents)) result.delete(`${sitePath}/${relative}`);
    for (const [relative, data] of Object.entries(plan.documents)) result.set(`${sitePath}/${relative}`, engine.encodeNestedArrays(data));
    reports.push({ site: sitePath, versions: plan.versions, warnings: plan.warnings, source_hash: plan.source_hash, result_hash: plan.result_hash });
  }
  return { source, result, reports };
}

export async function runUnifiedPagesMigration({ services, verifiedBackup, assertWriteFreeze }) {
  await assertWriteFreeze();
  const { source, result, reports } = await prepareUnifiedPagesMigration({ verifiedBackup, types: services.firestore.types });
  const readCurrent = async () => {
    const current = new Map();
    for await (const record of services.firestore.listDocuments()) if (record.path !== SELF_HOST_INSTALLATION_PATH) current.set(record.path, record.data);
    return current;
  };
  const current = await readCurrent();
  const paths = [...new Set([...source.keys(), ...result.keys()])].sort();
  for (const path of current.keys()) if (!source.has(path) && !result.has(path)) throw new Error(`Unexpected document appeared after backup: ${path}`);
  for (const path of paths) {
    if (!isDeepStrictEqual(current.get(path), source.get(path)) && !isDeepStrictEqual(current.get(path), result.get(path))) throw new Error(`Document changed after backup: ${path}`);
  }
  let written = 0;
  for (const path of paths) {
    if (isDeepStrictEqual(current.get(path), result.get(path))) continue;
    await assertWriteFreeze();
    if (!await services.firestore.compareAndWrite(path, current.get(path) ?? null, result.get(path) ?? null)) throw new Error(`Concurrent write detected: ${path}`);
    written++;
  }
  await assertWriteFreeze();
  if (!isDeepStrictEqual(await readCurrent(), result)) throw new Error('Migration verification failed; keep all writers stopped');
  return { written, reports };
}
