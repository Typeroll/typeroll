import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_TAG_PATTERN = /^core-v(.+)$/;

function readExportedVersion(repositoryRoot, relative, exportName) {
  const source = readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const match = source.match(new RegExp(`export const ${exportName} = ['"]([^'"]+)['"];`));
  if (!match) throw new Error(`Could not read ${exportName} from ${relative}`);
  return match[1];
}

export function readCoreVersions(repositoryRoot = root) {
  const packageManifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  return {
    package: packageManifest.version,
    runtime: readExportedVersion(
      repositoryRoot,
      'packages/shared/src/release.ts',
      'CORE_VERSION',
    ),
    selfHost: readExportedVersion(
      repositoryRoot,
      'scripts/lib/self-host-schema.mjs',
      'SELF_HOST_CORE_VERSION',
    ),
  };
}

export function verifyCoreReleaseVersion(releaseTag, versions = readCoreVersions()) {
  const match = releaseTag?.match(CORE_TAG_PATTERN);
  if (!match) throw new Error(`Expected a Core release tag, received: ${releaseTag || '<empty>'}`);

  const expected = match[1];
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== expected)
    .map(([source, version]) => `${source}=${version}`);
  if (mismatches.length) {
    throw new Error(
      `Core release ${releaseTag} does not match every version source: ${mismatches.join(', ')}`,
    );
  }
  return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releaseTag = process.argv[2];
  const version = verifyCoreReleaseVersion(releaseTag);
  console.log(`Core release version ${version} is consistent.`);
}
