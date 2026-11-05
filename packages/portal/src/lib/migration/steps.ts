// Resumable, bounded steps over an export file, shared by the CLI (a local
// file) and the portal Worker (an R2 object read by byte range).
//
// A step reads up to `maxBytes` of whole lines from a cursor, processes them
// and returns the next checkpoint. The caller persists the checkpoint after
// every step; rerunning a step is harmless because the import is idempotent.
// In the Worker, an operator-only internal entry point calls `importStep` (and
// then `compareStep`) until `done`, storing the checkpoint between requests,
// so no single request exceeds its CPU or memory limits.

import { canonicalJson, type ExportManifest } from './format';
import { drainOutboxes, emptyImportReport, ensureSiteOwners, importLines, type ImportOptions, type ImportReport, type MigrationTarget } from './import';
import { compareLines, emptyCompareReport, type CompareReader, type CompareReport } from './compare';

export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Byte offset of the next unread line and that line's 1-based number. */
export interface Cursor { offset: number; line: number }

export const DEFAULT_STEP_BYTES = 4 * 1024 * 1024;

/** Whole lines from `cursor`, at least one even when it is longer than `maxBytes`. */
export async function readStep(source: ByteSource, cursor: Cursor, maxBytes = DEFAULT_STEP_BYTES): Promise<{ lines: Array<{ line: number; text: string }>; next: Cursor; done: boolean }> {
  if (cursor.offset >= source.size) return { lines: [], next: cursor, done: true };
  let length = maxBytes, bytes: Uint8Array, end: number;
  for (;;) {
    bytes = await source.read(cursor.offset, Math.min(length, source.size - cursor.offset));
    end = bytes.lastIndexOf(0x0a);
    if (end >= 0 || cursor.offset + bytes.length >= source.size) break;
    length *= 2;
  }
  // At the end of the file take everything: its last line may lack a newline.
  const atEnd = cursor.offset + bytes.length >= source.size;
  const consumed = atEnd ? bytes.length : end + 1;
  const body = bytes.subarray(0, atEnd && bytes.at(-1) !== 0x0a ? bytes.length : consumed - 1);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  const lines = text.split('\n').map((value, i) => ({ line: cursor.line + i, text: value }));
  const next = { offset: cursor.offset + consumed, line: cursor.line + lines.length };
  return { lines, next, done: next.offset >= source.size };
}

export interface ImportCheckpoint {
  /** The export this checkpoint belongs to (manifest checksum). */
  export_sha256: string;
  options: { force: boolean; dryRun: boolean };
  cursor: Cursor;
  site_objects_created: number;
  outbox_entries_drained: number;
  done: boolean;
  report: ImportReport;
}

export function newImportCheckpoint(manifest: ExportManifest, opts: ImportOptions): ImportCheckpoint {
  return {
    export_sha256: manifest.sha256, options: { force: opts.force === true, dryRun: opts.dryRun === true },
    cursor: { offset: 0, line: 1 }, site_objects_created: 0, outbox_entries_drained: 0, done: false, report: emptyImportReport(),
  };
}

/** One bounded import step. The first creates site objects; the last drains outboxes. */
export async function importStep(target: MigrationTarget, source: ByteSource, manifest: ExportManifest, checkpoint: ImportCheckpoint, opts: ImportOptions & { maxBytes?: number } = {}): Promise<ImportCheckpoint> {
  if (checkpoint.export_sha256 !== manifest.sha256) throw new Error('The checkpoint belongs to another export');
  if (canonicalJson(checkpoint.options) !== canonicalJson({ force: opts.force === true, dryRun: opts.dryRun === true })) throw new Error('Resume with the options the import started with');
  if (checkpoint.done) return checkpoint;
  const next = structuredClone(checkpoint);
  if (next.cursor.offset === 0) next.site_objects_created = await ensureSiteOwners(target, manifest.sites, opts.dryRun);
  const step = await readStep(source, next.cursor, opts.maxBytes);
  await importLines(target, step.lines, opts, next.report);
  next.cursor = step.next;
  if (step.done) {
    if (!opts.dryRun) next.outbox_entries_drained = await drainOutboxes(target, manifest);
    next.done = true;
  }
  return next;
}

export interface CompareCheckpoint { export_sha256: string; cursor: Cursor; done: boolean; report: CompareReport }

export const newCompareCheckpoint = (manifest: ExportManifest): CompareCheckpoint =>
  ({ export_sha256: manifest.sha256, cursor: { offset: 0, line: 1 }, done: false, report: emptyCompareReport() });

export async function compareStep(reader: CompareReader, source: ByteSource, manifest: ExportManifest, checkpoint: CompareCheckpoint, opts: { maxBytes?: number; maxDocumentBytes?: number } = {}): Promise<CompareCheckpoint> {
  if (checkpoint.export_sha256 !== manifest.sha256) throw new Error('The checkpoint belongs to another export');
  if (checkpoint.done) return checkpoint;
  const next = structuredClone(checkpoint);
  const step = await readStep(source, next.cursor, opts.maxBytes);
  await compareLines(reader, step.lines, next.report, opts);
  next.cursor = step.next;
  next.done = step.done;
  return next;
}

/** The parts of an R2 bucket binding a step reads. */
export interface R2BucketLike {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string, options: { range: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** An export object in R2 (the EU-jurisdiction migration bucket), read by byte range. */
export async function r2ByteSource(bucket: R2BucketLike, key: string): Promise<ByteSource> {
  const head = await bucket.head(key);
  if (!head) throw new Error(`Export object not found: ${key}`);
  return {
    size: head.size,
    async read(offset, length) {
      const object = await bucket.get(key, { range: { offset, length } });
      if (!object) throw new Error(`Export object disappeared: ${key}`);
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

/** An export already in memory (tests, small rehearsals). */
export function bufferByteSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}
