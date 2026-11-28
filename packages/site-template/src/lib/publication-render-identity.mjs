import { createHash } from 'node:crypto';

// Provenance and repository instructions are regenerated outside raw page HTML.
// release.ts is the Core API/data-schema metadata, never a renderer input.
// A boundary test refuses consumers of those exports in the frozen renderer.
const METADATA = new Set(['README.md', 'LICENSE.typeroll', '.gitignore', 'packages/shared/src/release.ts']);
export function rendererSourceDigest(files) {
  const inputs = Object.fromEntries(Object.entries(files)
    .filter(([name]) => name !== 'publication.json' && !name.startsWith('content/') && !METADATA.has(name))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}
