import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BWRAP_URL, BWRAP_SHA, responseBytes } from '../packages/portal/src/lib/builds/executor.mjs';
import { APPARMOR_URL, APPARMOR_SHA } from '../packages/portal/src/lib/builds/github-sandbox.mjs';
import { digest } from './release-artifact.mjs';
export const dependencies = [
  { name: 'bubblewrap', url: BWRAP_URL, sha256: BWRAP_SHA, limit: 100000 },
  { name: 'apparmor-profile', url: APPARMOR_URL, sha256: APPARMOR_SHA, limit: 16384 },
];
export async function verifyDependency(dependency, request = fetch) {
  try {
    const response = await request(dependency.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const bytes = await responseBytes(response, dependency.limit);
    if (digest(bytes) !== dependency.sha256) throw Error('SHA-256 mismatch');
    return { name: dependency.name, bytes: bytes.length, sha256: dependency.sha256 };
  } catch (error) { throw Error(`Release dependency ${dependency.name}: ${error.message}`); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const dependency of dependencies) console.log(JSON.stringify(await verifyDependency(dependency)));
}
