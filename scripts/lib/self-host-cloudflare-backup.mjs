// Backup and restore of a self-hosted Cloudflare installation's document store.
//
// A backup is the store migration's export format (canonical NDJSON plus its
// manifest, packages/portal/src/lib/migration/format.ts), read from the
// portal's store objects page by page, checked locally and copied to the EU
// backups bucket. A restore uploads such an export to that bucket and lets the
// portal verify, import and read-compare it in bounded, resumable steps: the
// same `runMigrationStep` (lib/migration/worker-run.ts) that the cutover
// import runs, over the portal's MIGRATION binding, which the self-host
// profile points at the backups bucket. Checkpoints live next to the export in
// the bucket, so an interrupted restore resumes from any machine.
//
// Accounts are documents in the store (`auth_*`), so a backup includes them.
// Media files stay in R2 and are not part of a store backup.
//
// Durable Objects are reachable only from inside the portal Worker, so both
// directions use its store transfer endpoint. Every request carries
// TYPEROLL_STORE_TRANSFER_TOKEN; the endpoint answers 404 when the token is
// unset or wrong, indistinguishable from a missing route. Set the token only
// for a backup or restore.
//
// Store transfer contract (POST <portal>/api/internal/store-transfer, JSON):
//   { action: 'objects' }                         -> { objects: [{ name, kind }] }
//       every store object: 'global', 'org:<id>', 'site:<uid>' (kind global|org|site)
//   { action: 'paths', object, after, limit }     -> { paths: string[], next: string | null }
//       document paths of one object in path order after `after` ('' = start)
//   { action: 'get_many', object, paths }         -> { documents: Array<{ data } | null> }
//       stored data, in request order
//   { action: 'migration', run, step, force? }    -> MigrationStatus
//       `runMigrationStep` with { run, action: step, force } for step
//       verify | import | compare | status, over the MIGRATION binding; the
//       token is the window, so the steps are enabled for this route.
import fs from 'node:fs';
import path from 'node:path';
import { SELF_HOST_BACKUP_FORMAT_VERSION } from './self-host-schema.mjs';
import { SelfHostError } from './self-host-cloudflare.mjs';

export const TRANSFER_PATH = '/api/internal/store-transfer';
export const TRANSFER_TOKEN = 'TYPEROLL_STORE_TRANSFER_TOKEN';
const PAGE = 1000;
// `wrangler r2 object put` uploads files up to this size.
const WRANGLER_PUT_LIMIT = 300 * 1024 * 1024;
// Run names as runMigrationStep accepts them: one path segment.
const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function backupFiles(dir) {
  return { data: path.join(dir, 'store.ndjson'), manifest: path.join(dir, 'store.manifest.json'), descriptor: path.join(dir, 'backup.json') };
}

/** The portal's store transfer endpoint as a small client. */
export function storeTransferClient({ origin, token, fetch: fetchImpl }) {
  if (!token || token.length < 32) throw new SelfHostError(`${TRANSFER_TOKEN} must be set (at least 32 characters) on the portal and here`);
  const url = new URL(TRANSFER_PATH, origin).href;
  const call = async (action, payload = {}) => {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* reported below */ }
    if (response.status === 404) throw new SelfHostError(`The store transfer endpoint is not available at ${new URL(origin).host} (${TRANSFER_TOKEN} unset or different on the portal, or a Core version without it)`);
    if (!response.ok || !body) throw new SelfHostError(`Store transfer ${action} returned ${response.status}${body?.error ? `: ${body.error}` : ''}`);
    return body;
  };
  return {
    objects: async () => (await call('objects')).objects,
    paths: (object, after) => call('paths', { object, after, limit: PAGE }),
    getMany: async (object, paths) => (await call('get_many', { object, paths })).documents,
    migration: (run, step, force) => call('migration', { run, step, ...(force ? { force: true } : {}) }),
  };
}

/** Remote store objects in the shape `sqlSource` exports from. */
export function remoteObjects(client, objects) {
  return objects.map(({ name, kind }) => ({
    name, kind,
    async *paths() {
      let after = '';
      for (;;) {
        const page = await client.paths(name, after);
        yield* page.paths;
        if (!page.next) return;
        after = page.next;
      }
    },
    getMany: paths => client.getMany(name, paths),
  }));
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function uploadToBucket({ deps, bucket, key, file }) {
  if (fs.statSync(file).size > WRANGLER_PUT_LIMIT) {
    throw new SelfHostError(`${path.basename(file)} is larger than wrangler uploads (300 MiB); copy it to ${bucket}/${key} with the R2 S3 API (https://<account>.eu.r2.cloudflarestorage.com) and rerun with --skip-upload`);
  }
  await deps.wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--jurisdiction', 'eu', '--remote']);
}

async function verifyLocal(lib, files) {
  for (const file of [files.data, files.manifest]) if (!fs.existsSync(file)) throw new SelfHostError(`No backup file ${file}`);
  const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
  const verified = await lib.verifyExport(lib.readLines(fs.createReadStream(files.data)), manifest);
  if (!verified.ok) throw new SelfHostError(`The backup does not match its manifest: ${verified.problems.slice(0, 5).join('; ')}`);
  return manifest;
}

/**
 * Export the store into `dir` (store.ndjson, its manifest, backup.json),
 * verify it locally and copy it to `<run>/` in the EU backups bucket.
 */
export async function backupStore({ lib, client, origin, dir, bucket, run, coreVersion, deps, upload = true, now = () => new Date().toISOString(), log = () => {} }) {
  if (!RUN.test(run)) throw new SelfHostError(`Invalid backup run name ${run}`);
  const files = backupFiles(dir);
  if (fs.existsSync(files.data) || fs.existsSync(files.manifest)) throw new SelfHostError(`Refusing to overwrite the backup in ${dir}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = lib.sqlSource(remoteObjects(client, await client.objects()), { label: `worker:${new URL(origin).host}` });
  const partial = `${files.data}.partial`;
  const stream = fs.createWriteStream(partial, { mode: 0o600 });
  let records = 0;
  const manifest = await lib.exportStore(source, async line => {
    if (!stream.write(`${line}\n`)) await new Promise(resolve => stream.once('drain', resolve));
    if (++records % 10_000 === 0) log(`exported ${records} records`);
  }, { createdAt: now() });
  await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()));
  fs.renameSync(partial, files.data);
  writeJsonAtomic(files.manifest, manifest);
  await verifyLocal(lib, files);
  const descriptor = {
    format_version: SELF_HOST_BACKUP_FORMAT_VERSION,
    created_at: manifest.created_at,
    source: new URL(origin).host,
    core_version: coreVersion,
    records: manifest.records,
    sha256: manifest.sha256,
    bucket: upload ? { name: bucket, jurisdiction: 'eu', run } : null,
  };
  if (upload) {
    log(`copying the backup to ${bucket}/${run}/ (eu)`);
    await uploadToBucket({ deps, bucket, key: `${run}/store.ndjson`, file: files.data });
    await uploadToBucket({ deps, bucket, key: `${run}/store.manifest.json`, file: files.manifest });
  }
  writeJsonAtomic(files.descriptor, descriptor);
  return descriptor;
}

/** The run a restore of this export uses unless one is given: stable, so a rerun resumes. */
export function restoreRun(manifest) {
  return `restore-${String(manifest.sha256).slice(0, 24)}`;
}

/**
 * Restore a backup directory into the installation: verify it locally, copy
 * it to `<run>/` in the EU backups bucket, then verify, import and compare it
 * through the portal until each step is done. Rerunning resumes. The import
 * never overwrites a document that differs, unless `force`.
 */
export async function restoreStore({ lib, client, dir, bucket, deps, run, force = false, upload = true, log = () => {} }) {
  const files = backupFiles(dir);
  const manifest = await verifyLocal(lib, files);
  const name = run ?? restoreRun(manifest);
  if (!RUN.test(name)) throw new SelfHostError(`Invalid restore run name ${name}`);
  if (upload) {
    log(`copying the backup to ${bucket}/${name}/ (eu)`);
    await uploadToBucket({ deps, bucket, key: `${name}/store.ndjson`, file: files.data });
    await uploadToBucket({ deps, bucket, key: `${name}/store.manifest.json`, file: files.manifest });
  }

  let status = await client.migration(name, 'status');
  if (!status.verify?.ok) {
    status = await client.migration(name, 'verify');
    if (!status.verify?.ok) throw new SelfHostError(`The portal refused the backup: ${(status.verify?.problems ?? []).slice(0, 5).join('; ')}`);
  }
  while (!status.import?.done) {
    status = await client.migration(name, 'import', force);
    log(`imported through line ${status.import.cursor.line - 1} of ${manifest.records}`);
  }
  while (!status.compare?.done) {
    status = await client.migration(name, 'compare');
    log(`compared through line ${status.compare.cursor.line - 1} of ${manifest.records}`);
  }
  const ok = !lib.importFailed(status.import.report) && !lib.compareFailed(status.compare.report);
  return { ok, run: name, import: status.import.report, compare: status.compare.report };
}
