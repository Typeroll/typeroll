// A release artifact is reusable only for the exact qualified source and inputs.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function inventory(directory, prefix = '') {
  return readdirSync(path.join(directory, prefix)).sort().flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (relative === 'provenance.json') return [];
    const file = path.join(directory, relative), stat = lstatSync(file);
    if (stat.isDirectory()) return inventory(directory, relative);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Unsupported artifact entry: ${relative}`);
    return [[relative, digest(readFileSync(file))]];
  });
}
export function artifactIdentity(root = '.', runtime = process.versions.node) {
  return {
    source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    lock_sha256: digest(readFileSync(path.join(root, 'package-lock.json'))),
    node_version: runtime, target: 'docs-subdirectory',
  };
}
export function verifyArtifact(directory, expected) {
  const proof = JSON.parse(readFileSync(path.join(directory, 'provenance.json'), 'utf8'));
  if (proof.version !== 1 || JSON.stringify(proof.identity) !== JSON.stringify(expected)) throw Error('Artifact source, lock, runtime or target mismatch');
  if (JSON.stringify(proof.files) !== JSON.stringify(inventory(directory))) throw Error('Artifact files changed after qualification');
  if (!proof.files.length) throw Error('Empty release artifact');
  return proof;
}
export function sealArtifact(directory, identity) {
  const proof = { version: 1, identity, files: inventory(directory) };
  if (!proof.files.length) throw Error('Empty release artifact');
  writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n');
  return proof;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory] = process.argv.slice(2);
  if (!['seal', 'verify'].includes(action) || !directory) throw Error('Usage: release-artifact.mjs seal|verify DIRECTORY');
  const proof = (action === 'seal' ? sealArtifact : verifyArtifact)(directory, artifactIdentity());
  console.log(JSON.stringify({ action, identity: proof.identity, files: proof.files.length, artifact_sha256: digest(JSON.stringify(proof.files)) }));
}
