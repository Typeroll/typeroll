import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BWRAP_URL, BWRAP_SHA, responseBytes } from '../packages/portal/src/lib/builds/executor.mjs';
import { APPARMOR_URL, APPARMOR_SHA } from '../packages/portal/src/lib/builds/github-sandbox.mjs';
import { digest } from './release-artifact.mjs';
export const dependencies = [
  { name: 'bubblewrap', url: BWRAP_URL, sha256: BWRAP_SHA, limit: 100000 },
  { name: 'apparmor-profile', url: APPARMOR_URL, sha256: APPARMOR_SHA, limit: 16384 },
];
/**
 * Two failures live here and they call for opposite responses.
 *
 * The host being unreachable means wait and retry: the artifact is fine and
 * somebody else's server is not. A digest that does not match means the bytes
 * at a pinned URL changed, which is a supply-chain event and must never be
 * retried away. On 2026-09-22 snapshot.ubuntu.com returned 503 for hours and
 * the message read `Release dependency bubblewrap: HTTP 503` — correct, and
 * shaped exactly like the one that would mean the opposite.
 */
export async function verifyDependency(dependency, request = fetch) {
  let bytes;
  try {
    const response = await request(dependency.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw Error(
        `UNAVAILABLE: ${dependency.name} could not be fetched from ${dependency.url} (HTTP ${response.status}). ` +
        'The pinned artifact is not in question; its host is. Retry when the host recovers.',
      );
    }
    bytes = await responseBytes(response, dependency.limit);
  } catch (error) {
    if (error.message.startsWith('UNAVAILABLE:')) throw error;
    throw Error(
      `UNAVAILABLE: ${dependency.name} could not be fetched from ${dependency.url} (${error.message}). ` +
      'The pinned artifact is not in question; its host is. Retry when the host recovers.',
    );
  }
  const actual = digest(bytes);
  if (actual !== dependency.sha256) {
    throw Error(
      `INTEGRITY: ${dependency.name} at ${dependency.url} hashes to ${actual}, pinned ${dependency.sha256}. ` +
      'The bytes at a pinned URL changed. Do not retry; establish why before releasing anything.',
    );
  }
  return { name: dependency.name, bytes: bytes.length, sha256: dependency.sha256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const dependency of dependencies) console.log(JSON.stringify(await verifyDependency(dependency)));
}
