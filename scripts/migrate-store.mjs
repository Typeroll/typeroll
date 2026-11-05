#!/usr/bin/env node
// One-time document store migration: Firestore → Durable Object store.
// The runbook is docs/cloudflare-migration-runbook.md.
//
//   export  --source firestore|sqlite:FILE|local:DIR --out FILE.ndjson [--concurrency N] [--dry-run]
//   verify  --in FILE.ndjson
//   import  --in FILE.ndjson --target local:DIR [--users FILE.json] [--force] [--dry-run]
//           [--checkpoint FILE] [--step-bytes N] [--report FILE]
//   compare --in FILE.ndjson --target local:DIR|sqlite:FILE [--report FILE]
//
// FILE.manifest.json sits next to FILE.ndjson. `local:DIR` is a set of SQLite
// files sharded like the production objects, for rehearsals; the production
// import runs inside the portal Worker on the same library (steps.ts).
// Exit status: 0 clean, 1 differences, conflicts or damaged input, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadMigrationLibrary } from './lib/migration-library.mjs';

const USAGE = `Usage:
  node scripts/migrate-store.mjs export  --source firestore|sqlite:FILE|local:DIR --out FILE.ndjson [--concurrency N] [--dry-run]
  node scripts/migrate-store.mjs verify  --in FILE.ndjson
  node scripts/migrate-store.mjs import  --in FILE.ndjson --target local:DIR [--users FILE.json] [--force] [--dry-run] [--checkpoint FILE] [--step-bytes N] [--report FILE]
  node scripts/migrate-store.mjs compare --in FILE.ndjson --target local:DIR|sqlite:FILE [--report FILE]`;

class UsageError extends Error {}

const options = {
  source: { type: 'string' }, out: { type: 'string' }, in: { type: 'string' }, target: { type: 'string' },
  users: { type: 'string' }, checkpoint: { type: 'string' }, report: { type: 'string' },
  concurrency: { type: 'string' }, 'step-bytes': { type: 'string' },
  force: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
};

export function manifestPathFor(file) {
  if (!file?.endsWith('.ndjson')) throw new UsageError('The export file name must end in .ndjson');
  return `${file.slice(0, -'.ndjson'.length)}.manifest.json`;
}

function positiveInteger(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return number;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readManifest(file) {
  const manifestPath = manifestPathFor(file);
  if (!fs.existsSync(file)) throw new UsageError(`No such export: ${file}`);
  if (!fs.existsSync(manifestPath)) throw new UsageError(`No manifest next to the export: ${manifestPath}`);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function fileByteSource(file) {
  const handle = fs.openSync(file, 'r');
  return {
    size: fs.fstatSync(handle).size,
    async read(offset, length) {
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(handle, buffer, 0, length, offset);
      return buffer.subarray(0, read);
    },
  };
}

function localDir(spec, { mustExist }) {
  const dir = spec?.match(/^local:(.+)$/)?.[1];
  if (!dir) return null;
  if (mustExist && !fs.existsSync(path.join(dir, 'global.sqlite'))) throw new UsageError(`No local store objects in ${dir}`);
  return dir;
}

/** Short, value-free summary; full lists go to --report. */
function summary(report) {
  const brief = {};
  for (const [key, value] of Object.entries(report)) brief[key] = Array.isArray(value) && value.length > 20 ? [...value.slice(0, 20), `… ${value.length - 20} more`] : value;
  return brief;
}

const verifyFile = (lib, file, manifest) => lib.verifyExport(lib.readLines(fs.createReadStream(file)), manifest);

async function runExport(lib, args, log) {
  if (!args.source || (!args.out && !args['dry-run'])) throw new UsageError('export needs --source and --out');
  let source;
  if (args.source === 'firestore') {
    const { db, projectId } = await lib.openFirestore(process.env);
    source = lib.firestoreSource(db, { label: `firestore:${projectId}`, concurrency: positiveInteger(args.concurrency, 'concurrency') });
  } else if (args.source.startsWith('sqlite:')) {
    source = lib.sqlSource([lib.sqliteFileObject(args.source.slice('sqlite:'.length))], { label: args.source });
  } else if (localDir(args.source, { mustExist: true })) {
    source = lib.sqlSource(lib.localShardedTarget(localDir(args.source, { mustExist: true })).objects(), { label: 'local' });
  } else throw new UsageError(`Unknown source: ${args.source}`);

  if (args['dry-run']) {
    const manifest = await lib.exportStore(source, () => {});
    log(`dry run: ${manifest.records} records, nothing written`);
    return { code: 0, output: manifest };
  }
  const manifestPath = manifestPathFor(args.out);
  if (fs.existsSync(args.out) || fs.existsSync(manifestPath)) throw new UsageError(`Refusing to overwrite ${args.out}`);
  const partial = `${args.out}.partial`;
  const stream = fs.createWriteStream(partial, { mode: 0o600 });
  let records = 0;
  const manifest = await lib.exportStore(source, async line => {
    if (!stream.write(`${line}\n`)) await new Promise(resolve => stream.once('drain', resolve));
    if (++records % 10000 === 0) log(`exported ${records} records`);
  });
  await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()));
  fs.renameSync(partial, args.out);
  writeJsonAtomic(manifestPath, manifest);
  log(`exported ${manifest.records} records to ${args.out}`);
  return { code: 0, output: { records: manifest.records, sha256: manifest.sha256, manifest: manifestPath } };
}

async function runVerify(lib, args) {
  if (!args.in) throw new UsageError('verify needs --in');
  const result = await verifyFile(lib, args.in, readManifest(args.in));
  return { code: result.ok ? 0 : 1, output: { ok: result.ok, problems: result.problems } };
}

async function runImport(lib, args, log) {
  if (!args.in || !args.target) throw new UsageError('import needs --in and --target');
  const dir = localDir(args.target, { mustExist: false });
  if (!dir) throw new UsageError('import --target must be local:DIR; the production import runs in the portal Worker');
  const manifest = readManifest(args.in);
  const verified = await verifyFile(lib, args.in, manifest);
  if (!verified.ok) return { code: 1, output: { ok: false, stage: 'verify', problems: verified.problems } };

  const opts = { force: args.force === true, dryRun: args['dry-run'] === true };
  const target = lib.localShardedTarget(dir);
  const checkpointPath = args.checkpoint ?? path.join(dir, 'import-checkpoint.json');
  let checkpoint = !opts.dryRun && fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) : lib.newImportCheckpoint(manifest, opts);
  if (checkpoint.done) log(`already finished according to ${checkpointPath}; remove it to import again`);
  else if (checkpoint.cursor.offset > 0) log(`resuming at line ${checkpoint.cursor.line}`);
  const source = fileByteSource(args.in);
  while (!checkpoint.done) {
    checkpoint = await lib.importStep(target, source, manifest, checkpoint, { ...opts, maxBytes: positiveInteger(args['step-bytes'], 'step-bytes') });
    if (!opts.dryRun) writeJsonAtomic(checkpointPath, checkpoint);
    log(`imported through line ${checkpoint.cursor.line - 1} of ${manifest.records}`);
  }

  let identity = null;
  if (args.users) {
    if (opts.dryRun) identity = { skipped: 'dry run' };
    else {
      // Only rows are written; the secret signs nothing here, so a throwaway one is enough.
      const secret = process.env.AUTH_SECRET?.trim() || randomBytes(32).toString('hex');
      const auth = lib.createPortalAuth({ secret, baseURL: process.env.PORTAL_PUBLIC_URL?.trim() || 'http://localhost:4321', store: () => target.store });
      identity = await lib.importIdentityExport(auth, fs.readFileSync(args.users, 'utf8'));
    }
  }
  const failed = lib.importFailed(checkpoint.report);
  if (args.report) writeJsonAtomic(args.report, { ...checkpoint, identity });
  return { code: failed ? 1 : 0, output: { ok: !failed, dryRun: opts.dryRun, site_objects_created: checkpoint.site_objects_created, outbox_entries_drained: checkpoint.outbox_entries_drained, ...summary(checkpoint.report), identity } };
}

async function runCompare(lib, args, log) {
  if (!args.in || !args.target) throw new UsageError('compare needs --in and --target');
  const manifest = readManifest(args.in);
  let reader;
  const dir = localDir(args.target, { mustExist: true });
  if (dir) reader = lib.shardedReader(lib.localShardedTarget(dir));
  else if (args.target.startsWith('sqlite:')) {
    const file = args.target.slice('sqlite:'.length);
    if (!fs.existsSync(file)) throw new UsageError(`No such store file: ${file}`);
    const object = lib.sqliteFileObject(file);
    reader = { getMany: async paths => (await object.getMany(paths)).map(doc => doc?.data ?? null) };
  } else throw new UsageError(`Unknown target: ${args.target}`);
  const source = fileByteSource(args.in);
  let checkpoint = lib.newCompareCheckpoint(manifest);
  while (!checkpoint.done) {
    checkpoint = await lib.compareStep(reader, source, manifest, checkpoint);
    log(`compared through line ${checkpoint.cursor.line - 1} of ${manifest.records}`);
  }
  const failed = lib.compareFailed(checkpoint.report);
  if (args.report) writeJsonAtomic(args.report, checkpoint.report);
  return { code: failed ? 1 : 0, output: { ok: !failed, ...summary(checkpoint.report) } };
}

export async function main(argv = process.argv.slice(2), { log = message => process.stderr.write(`${message}\n`), out = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) } = {}) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true }); }
  catch (error) { log(`${error.message}\n${USAGE}`); return 2; }
  const [command] = parsed.positionals;
  const args = parsed.values;
  if (args.help || !command) { log(USAGE); return args.help ? 0 : 2; }
  const commands = { export: runExport, verify: runVerify, import: runImport, compare: runCompare };
  if (!commands[command]) { log(`Unknown command: ${command}\n${USAGE}`); return 2; }
  // Nothing may be delivered or scheduled while data moves.
  process.env.DEPLOY_QUEUE = 'migration';
  try {
    const lib = await loadMigrationLibrary();
    const { code, output } = await commands[command](lib, args, log);
    out(output);
    return code;
  } catch (error) {
    if (error instanceof UsageError) { log(`${error.message}\n${USAGE}`); return 2; }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
