// The cutover import inside the portal Worker (runbook steps 5–6), one bounded
// step per call. The operator drives it through the operator API; the export,
// its manifest, the identity export and every checkpoint live in the
// EU-jurisdiction migration bucket under `<run>/`:
//   store.ndjson, store.manifest.json, users.json      (uploaded by the operator)
//   verify.json, import-checkpoint.json, identity-report.json,
//   compare-checkpoint.json                            (written here)
// Checkpoints and reports hold paths and counts, never document values.

import { readLines, verifyExport, type ExportManifest, type VerifyResult } from './format';
import { compareStep, importStep, newCompareCheckpoint, newImportCheckpoint, r2ByteSource, type CompareCheckpoint, type ImportCheckpoint, type R2BucketLike } from './steps';
import { shardedReader } from './compare';
import { importIdentityExport, type IdentityImportReport } from './identity';
import type { MigrationTarget } from './import';
import type { PortalAuth } from '../identity/portal-auth';

export interface MigrationBucket extends R2BucketLike {
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text?(): Promise<string>; body?: ReadableStream<Uint8Array> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

export interface MigrationRunDeps {
  bucket: MigrationBucket;
  target: MigrationTarget;
  auth: () => PortalAuth | null;
  /** Only `TYPEROLL_MIGRATION=allow` (set for the cutover window) enables the steps. */
  enabled: boolean;
}

export type MigrationAction = 'verify' | 'import' | 'identity' | 'compare' | 'status';

export interface MigrationStepRequest { run: string; action: MigrationAction; force?: boolean; maxBytes?: number }

export interface MigrationStatus {
  run: string;
  verify: VerifyResult | null;
  import: Pick<ImportCheckpoint, 'cursor' | 'done' | 'report'> | null;
  identity: IdentityImportReport | null;
  compare: Pick<CompareCheckpoint, 'cursor' | 'done' | 'report'> | null;
}

const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class MigrationRunError extends Error {}

async function readJson<T>(bucket: MigrationBucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as T;
}

async function* bodyChunks(bucket: MigrationBucket, key: string, size: number): AsyncGenerator<Uint8Array> {
  // Range reads keep memory bounded whatever the export size.
  const chunk = 8 * 1024 * 1024;
  for (let offset = 0; offset < size; offset += chunk) {
    const part = await bucket.get(key, { range: { offset, length: Math.min(chunk, size - offset) } });
    if (!part) throw new MigrationRunError(`Export object disappeared: ${key}`);
    yield new Uint8Array(await part.arrayBuffer());
  }
}

export async function runMigrationStep(deps: MigrationRunDeps, request: MigrationStepRequest): Promise<MigrationStatus> {
  if (!deps.enabled) throw new MigrationRunError('Migration steps are not enabled on this deployment');
  if (!RUN.test(request.run ?? '')) throw new MigrationRunError('Invalid run name');
  const { bucket } = deps, run = request.run;
  const key = (name: string) => `${run}/${name}`;
  const manifest = await readJson<ExportManifest>(bucket, key('store.manifest.json'));
  if (!manifest) throw new MigrationRunError('The run has no store.manifest.json');

  if (request.action === 'verify') {
    const head = await bucket.head(key('store.ndjson'));
    if (!head) throw new MigrationRunError('The run has no store.ndjson');
    const result = await verifyExport(readLines(bodyChunks(bucket, key('store.ndjson'), head.size)), manifest);
    await bucket.put(key('verify.json'), JSON.stringify({ ...result, manifest: null, export_sha256: manifest.sha256 }));
  } else if (request.action === 'import') {
    const verified = await readJson<VerifyResult & { export_sha256: string }>(bucket, key('verify.json'));
    if (!verified?.ok || verified.export_sha256 !== manifest.sha256) throw new MigrationRunError('Verify the export before importing it');
    const source = await r2ByteSource(bucket, key('store.ndjson'));
    const options = { force: request.force === true };
    const checkpoint = await readJson<ImportCheckpoint>(bucket, key('import-checkpoint.json')) ?? newImportCheckpoint(manifest, options);
    const next = await importStep(deps.target, source, manifest, checkpoint, { ...options, maxBytes: request.maxBytes });
    await bucket.put(key('import-checkpoint.json'), JSON.stringify(next));
  } else if (request.action === 'identity') {
    const auth = deps.auth();
    if (!auth) throw new MigrationRunError('Sign-in is not configured (AUTH_SECRET)');
    const users = await bucket.get(key('users.json'));
    if (!users) throw new MigrationRunError('The run has no users.json');
    const report = await importIdentityExport(auth, new TextDecoder().decode(await users.arrayBuffer()));
    await bucket.put(key('identity-report.json'), JSON.stringify(report));
  } else if (request.action === 'compare') {
    const imported = await readJson<ImportCheckpoint>(bucket, key('import-checkpoint.json'));
    if (!imported?.done) throw new MigrationRunError('Finish the import before comparing');
    const source = await r2ByteSource(bucket, key('store.ndjson'));
    const checkpoint = await readJson<CompareCheckpoint>(bucket, key('compare-checkpoint.json')) ?? newCompareCheckpoint(manifest);
    const next = await compareStep(shardedReader(deps.target), source, manifest, checkpoint, { maxBytes: request.maxBytes });
    await bucket.put(key('compare-checkpoint.json'), JSON.stringify(next));
  } else if (request.action !== 'status') {
    throw new MigrationRunError('Unknown migration action');
  }
  return migrationStatus(bucket, run);
}

async function migrationStatus(bucket: MigrationBucket, run: string): Promise<MigrationStatus> {
  const key = (name: string) => `${run}/${name}`;
  const pick = <T extends { cursor: unknown; done: boolean; report: unknown }>(value: T | null) => value && { cursor: value.cursor, done: value.done, report: value.report } as Pick<T, 'cursor' | 'done' | 'report'>;
  return {
    run,
    verify: await readJson<VerifyResult>(bucket, key('verify.json')),
    import: pick(await readJson<ImportCheckpoint>(bucket, key('import-checkpoint.json'))),
    identity: await readJson<IdentityImportReport>(bucket, key('identity-report.json')),
    compare: pick(await readJson<CompareCheckpoint>(bucket, key('compare-checkpoint.json'))),
  };
}
