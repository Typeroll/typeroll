// Incremental validation of a frozen build artifact read from R2.
//
// A binary (format 2) artifact can be 128 MiB, the whole memory of a Worker.
// This reader checks it in one pass over the stream: the total hash, the
// header and identity, every file's path, size and hash, and the publication
// marker. Only the files the caller asks for are kept in memory. The checks
// match `decodeArtifact` in contract.mjs, which the build engine also uses;
// previously issued JSON (format 1) artifacts are small and still go through it.

import { createHash } from 'node:crypto';
import { MAX_ARTIFACT_BYTES, assertBuildIdentity, assertFilePath, decodeArtifact, type BuildIdentity } from './contract.mjs';

const MAGIC = Buffer.from('TYPEROLL-ARTIFACT-2\n');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20000;
const MARKER = '.well-known/typeroll/publication.json';

export interface ArtifactEntry { name: string; sha256: string; size: number }
export interface InspectedArtifact {
  /** Every file in artifact order, with its verified hash and size. */
  entries: ArtifactEntry[];
  /** The retained files (always including the publication marker). */
  files: Record<string, Buffer>;
}
/** Given every file name in the artifact, decide which file contents to keep. */
export type RetainPolicy = (names: string[]) => (name: string) => boolean;

export const retainAll: RetainPolicy = () => () => true;
export const retainNamed = (...names: string[]): RetainPolicy => () => (name) => names.includes(name);

const mismatch = (message = 'Static artifact integrity mismatch') => new Error(message);

/** Pulls exact byte counts from an async chunk source. */
class ByteReader {
  private iterator: AsyncIterator<Uint8Array>;
  private pending: Buffer = Buffer.alloc(0);
  total = 0;
  private readonly hash = createHash('sha256');
  constructor(source: AsyncIterable<Uint8Array>, private readonly limit: number) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  private async more(): Promise<boolean> {
    const next = await this.iterator.next();
    if (next.done) return false;
    const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    this.total += chunk.length;
    if (this.total > this.limit) throw mismatch();
    this.hash.update(chunk);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    return true;
  }
  /** Exactly `count` bytes, or null at a clean end of input. */
  async take(count: number): Promise<Buffer | null> {
    while (this.pending.length < count) {
      if (await this.more()) continue;
      if (this.pending.length) throw mismatch();
      return null;
    }
    const value = this.pending.subarray(0, count);
    this.pending = this.pending.subarray(count);
    return value;
  }
  /** Feed `count` bytes to `sink` without holding more than one chunk. */
  async pipe(count: number, sink: (chunk: Buffer) => void): Promise<void> {
    let left = count;
    while (left > 0) {
      if (!this.pending.length && !await this.more()) throw mismatch('Static output integrity mismatch');
      const part = this.pending.subarray(0, Math.min(left, this.pending.length));
      this.pending = this.pending.subarray(part.length);
      left -= part.length;
      sink(part);
    }
  }
  async rest(): Promise<Buffer> {
    const chunks = [this.pending];
    this.pending = Buffer.alloc(0);
    while (await this.more()) { chunks.push(this.pending); this.pending = Buffer.alloc(0); }
    return Buffer.concat(chunks);
  }
  async atEnd(): Promise<boolean> { return !this.pending.length && !await this.more(); }
  digest(): string { return this.hash.digest('hex'); }
  async cancel() { await this.iterator.return?.(); }
}

/** Validate an artifact stream like `decodeArtifact`, keeping only the files `retain` selects. */
export async function inspectArtifact(source: AsyncIterable<Uint8Array>, identity: BuildIdentity, expectedHash: string, retain: RetainPolicy): Promise<InspectedArtifact> {
  assertBuildIdentity(identity);
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw mismatch();
  const reader = new ByteReader(source, MAX_ARTIFACT_BYTES);
  try {
    const head = await reader.take(MAGIC.length).catch(() => null);
    if (!head?.equals(MAGIC)) {
      // Format 1 (JSON) artifacts predate the binary framing and are decoded whole.
      const bytes = Buffer.concat([head ?? Buffer.alloc(0), await reader.rest()]);
      const decoded = decodeArtifact(bytes, identity, expectedHash);
      const names = Object.keys(decoded);
      const keep = retain(names);
      return {
        entries: names.map((name) => ({ name, sha256: createHash('sha256').update(decoded[name]!).digest('hex'), size: decoded[name]!.length })),
        files: Object.fromEntries(names.filter((name) => name === MARKER || keep(name)).map((name) => [name, decoded[name]!])),
      };
    }
    const lengthBytes = await reader.take(4);
    if (!lengthBytes) throw mismatch();
    const length = lengthBytes.readUInt32BE(0);
    if (!length || length > MAX_ARTIFACT_BYTES) throw mismatch();
    const manifestBytes = await reader.take(length);
    if (!manifestBytes) throw mismatch();
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.protocol !== 2 || Object.keys(identity).some((key) => manifest.identity?.[key] !== identity[key as keyof BuildIdentity]) ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw mismatch('Static artifact identity mismatch');
    const names = manifest.files.map((entry: { name?: unknown }) => entry?.name);
    const keep = retain(names.filter((name: unknown): name is string => typeof name === 'string'));
    const entries: ArtifactEntry[] = [];
    const files: Record<string, Buffer> = Object.create(null);
    const seen = new Set<string>();
    let total = 0;
    for (const entry of manifest.files) {
      assertFilePath(entry?.name, { artifact: true });
      if (seen.has(entry.name)) throw mismatch('Duplicate or invalid static output');
      seen.add(entry.name);
      if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 || entry.size_bytes > MAX_FILE_BYTES) throw mismatch('Static output integrity mismatch');
      total += entry.size_bytes;
      if (total > MAX_ARTIFACT_BYTES) throw mismatch('Static output integrity mismatch');
      const hash = createHash('sha256');
      const kept = entry.name === MARKER || keep(entry.name) ? [] as Buffer[] : null;
      await reader.pipe(entry.size_bytes, (chunk) => { hash.update(chunk); kept?.push(Buffer.from(chunk)); });
      const digest = hash.digest('hex');
      if (digest !== entry.sha256) throw mismatch('Static output integrity mismatch');
      entries.push({ name: entry.name, sha256: digest, size: entry.size_bytes });
      if (kept) files[entry.name] = Buffer.concat(kept);
    }
    if (!await reader.atEnd()) throw mismatch();
    if (reader.digest() !== expectedHash) throw mismatch();
    const marker = JSON.parse(files[MARKER]?.toString('utf8') ?? 'null');
    if (marker?.id !== identity.publication_id) throw mismatch('Static publication marker mismatch');
    return { entries, files: { ...files } };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}
