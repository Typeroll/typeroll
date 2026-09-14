import { expect, it } from 'vitest';
import { BUILD_RUNTIME, MAX_ARTIFACT_BYTES, encodeArtifact, decodeArtifact, sha256, type BuildIdentity } from '../../lib/builds/contract.mjs';
import { artifactFailureCode } from '../../lib/builds/executor.mjs';

const identity: BuildIdentity = { protocol: 1, org_id: 'org', site_id: 'site', version_id: 'main', job_id: 'job', publication_id: 'a'.repeat(64), source_sha256: 'b'.repeat(64), commit: 'c'.repeat(40), branch: 'main', node_version: BUILD_RUNTIME };
const marker = { '.well-known/typeroll/publication.json': Buffer.from(JSON.stringify({ id: identity.publication_id })) };
const read = (bytes: Buffer) => decodeArtifact(bytes, identity, sha256(bytes));

it('round-trips a 108 MiB static site whose base64 representation exceeds the unchanged 128 MiB limit', () => {
  const data = Buffer.alloc(18 * 1024 * 1024, 0xa7);
  const files = { ...marker, ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`media/${i}.bin`, data])) };
  expect(data.length * 6 * 4 / 3).toBeGreaterThan(MAX_ARTIFACT_BYTES);
  const artifact = encodeArtifact(identity, files);
  expect(artifact.length).toBeLessThan(MAX_ARTIFACT_BYTES);
  expect(artifact.length).toBeGreaterThan(data.length * 6);
  const decoded = read(artifact);
  expect(Object.keys(decoded)).toHaveLength(7);
  for (let i = 0; i < 6; i++) expect(decoded[`media/${i}.bin`].equals(data)).toBe(true);
});

it('still enforces per-file, aggregate and transport size limits', () => {
  expect(() => encodeArtifact(identity, { ...marker, 'large.bin': Buffer.alloc(25 * 1024 * 1024 + 1) })).toThrow('Invalid static output file');
  const data = Buffer.alloc(22 * 1024 * 1024);
  expect(() => encodeArtifact(identity, { ...marker, ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${i}.bin`, data])) })).toThrow('size limit');
  expect(() => read(Buffer.alloc(MAX_ARTIFACT_BYTES + 1))).toThrow('integrity');
});

it('rejects truncated framing, truncated payload, extra bytes and corruption with a recomputed envelope hash', () => {
  const artifact = encodeArtifact(identity, { ...marker, 'index.html': Buffer.from('<h1>Static</h1>') });
  for (const bytes of [artifact.subarray(0, 20), artifact.subarray(0, -1), Buffer.concat([artifact, Buffer.from('extra')])]) expect(() => read(bytes)).toThrow('integrity');
  const corrupted = Buffer.from(artifact); corrupted[corrupted.length - 1] ^= 1;
  expect(() => read(corrupted)).toThrow('integrity');
});

it('continues to verify artifacts issued by older JSON runners', () => {
  const files = { ...marker, 'index.html': Buffer.from('Legacy') };
  const legacy = { protocol: 1, identity, files: Object.entries(files).map(([name, data]) => ({ name, sha256: sha256(data), data: data.toString('base64') })) };
  expect(read(Buffer.from(JSON.stringify(legacy)))['index.html'].toString()).toBe('Legacy');
  legacy.files[1].data = Buffer.from('Tampered').toString('base64');
  expect(() => read(Buffer.from(JSON.stringify(legacy)))).toThrow('integrity');
});

it('keeps provider diagnostics specific without exposing arbitrary error text', () => {
  expect(artifactFailureCode('Static artifact exceeds the size limit')).toBe('static_output_size_limit');
  expect(artifactFailureCode('Invalid build file path')).toBe('invalid_static_path');
  expect(artifactFailureCode('request failed with private credential value')).toBe('build_failed');
});
