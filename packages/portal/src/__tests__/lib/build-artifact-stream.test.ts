import { describe, expect, it } from 'vitest';
import { BUILD_PROTOCOL, BUILD_RUNTIME, decodeArtifact, encodeArtifact, sha256 } from '../../lib/builds/contract.mjs';
import { inspectArtifact, retainAll, retainNamed } from '../../lib/builds/artifact-stream';

const identity = { org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'job', publication_id: 'b'.repeat(64), commit: 'c'.repeat(40),
  branch: 'main', protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME, source_sha256: 'd'.repeat(64) } as const;
const marker = Buffer.from(JSON.stringify({ id: identity.publication_id }));
const files = { '.well-known/typeroll/publication.json': marker, 'index.html': Buffer.from('<h1>Home</h1>'), 'assets/app.css': Buffer.alloc(5000, 'a'), 'empty.txt': Buffer.alloc(0) };
const chunked = (bytes: Buffer, size = 13) => (async function* () { for (let at = 0; at < bytes.length; at += size) yield new Uint8Array(bytes.subarray(at, at + size)); })();
const inspect = (bytes: Buffer, retain = retainAll, hash = sha256(bytes), id: typeof identity = identity) => inspectArtifact(chunked(bytes), id as never, hash, retain);
// Rewrite the header manifest and keep the framing valid.
function withManifest(bytes: Buffer, change: (manifest: any) => void): Buffer {
  const magic = 'TYPEROLL-ARTIFACT-2\n'.length, length = bytes.readUInt32BE(magic);
  const manifest = JSON.parse(bytes.subarray(magic + 4, magic + 4 + length).toString('utf8'));
  change(manifest);
  const encoded = Buffer.from(JSON.stringify(manifest)), size = Buffer.alloc(4); size.writeUInt32BE(encoded.length);
  return Buffer.concat([bytes.subarray(0, magic), size, encoded, bytes.subarray(magic + 4 + length)]);
}

describe('inspectArtifact', () => {
  it('accepts exactly what decodeArtifact accepts and reports every file', async () => {
    const bytes = encodeArtifact(identity as never, files);
    const decoded = decodeArtifact(bytes, identity as never, sha256(bytes));
    const result = await inspect(bytes);
    expect(result.files).toEqual({ ...decoded });
    expect(result.entries).toEqual(Object.entries(decoded).map(([name, value]) => ({ name, sha256: sha256(value), size: value.length })));
    for (const size of [1, 4096, bytes.length]) expect((await inspectArtifact(chunked(bytes, size), identity as never, sha256(bytes), retainAll)).entries).toHaveLength(4);
  });

  it('keeps only the selected files and the publication marker', async () => {
    const bytes = encodeArtifact(identity as never, files);
    const result = await inspect(bytes, retainNamed('index.html'));
    expect(Object.keys(result.files).sort()).toEqual(['.well-known/typeroll/publication.json', 'index.html']);
    expect(result.entries.find(entry => entry.name === 'assets/app.css')).toEqual({ name: 'assets/app.css', sha256: sha256(files['assets/app.css']), size: 5000 });
  });

  it.each([
    ['a changed total hash', (bytes: Buffer) => ({ bytes, hash: 'e'.repeat(64) }), /integrity mismatch/],
    ['a flipped content byte', (bytes: Buffer) => { const copy = Buffer.from(bytes); copy[copy.length - 1]! ^= 1; return { bytes: copy }; }, /integrity mismatch/],
    ['trailing bytes', (bytes: Buffer) => ({ bytes: Buffer.concat([bytes, Buffer.from('x')]) }), /integrity mismatch/],
    ['a truncated artifact', (bytes: Buffer) => ({ bytes: bytes.subarray(0, bytes.length - 3) }), /integrity mismatch/],
    ['a size that does not match', (bytes: Buffer) => ({ bytes: withManifest(bytes, m => { m.files[1].size_bytes += 1; }) }), /integrity mismatch/],
    ['a duplicate file', (bytes: Buffer) => ({ bytes: withManifest(bytes, m => { m.files[2].name = m.files[1].name; }) }), /Duplicate|integrity/],
    ['a dynamic file', (bytes: Buffer) => ({ bytes: withManifest(bytes, m => { m.files[1].name = '_worker.js'; }) }), /not static output/],
    ['another identity', (bytes: Buffer) => ({ bytes: withManifest(bytes, m => { m.identity.site_id = 'other'; }) }), /identity mismatch/],
  ])('rejects %s', async (_label, tamper, error) => {
    const { bytes, hash } = { hash: undefined as string | undefined, ...tamper(encodeArtifact(identity as never, files)) };
    await expect(inspect(bytes, retainAll, hash ?? sha256(bytes))).rejects.toThrow(error);
  });

  it('requires the marker of this publication', async () => {
    const bytes = encodeArtifact(identity as never, { ...files, '.well-known/typeroll/publication.json': Buffer.from('{"id":"other"}') });
    await expect(inspect(bytes, retainNamed())).rejects.toThrow(/marker mismatch/);
  });

  it('still reads format 1 (JSON) artifacts', async () => {
    const entries = Object.entries(files).map(([name, data]) => ({ name, sha256: sha256(data), data: data.toString('base64') }));
    const bytes = Buffer.from(JSON.stringify({ protocol: BUILD_PROTOCOL, identity, files: entries }));
    const result = await inspect(bytes, retainNamed());
    expect(result.entries.map(entry => entry.name).sort()).toEqual(Object.keys(files).sort());
    expect(Object.keys(result.files)).toEqual(['.well-known/typeroll/publication.json']);
  });

  it('stops reading as soon as the stream exceeds the artifact limit', async () => {
    let produced = 0, cancelled = false;
    const endless = { [Symbol.asyncIterator]: () => ({
      next: async () => { produced++; return { done: false, value: new Uint8Array(8 * 1024 * 1024) }; },
      return: async () => { cancelled = true; return { done: true, value: undefined }; },
    }) };
    await expect(inspectArtifact(endless as never, identity as never, 'a'.repeat(64), retainAll)).rejects.toThrow(/integrity mismatch/);
    expect(produced).toBeLessThanOrEqual(17);
    expect(cancelled).toBe(true);
  });
});
