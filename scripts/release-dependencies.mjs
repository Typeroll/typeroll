import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BWRAP_SOURCES, BWRAP_SHA, acquireSandbox, responseBytes } from '../packages/portal/src/lib/builds/executor.mjs';
import { APPARMOR_URL, APPARMOR_SHA } from '../packages/portal/src/lib/builds/github-sandbox.mjs';
import { digest } from './release-artifact.mjs';
// Bubblewrap is one pinned artifact, checked the same way publication builds
// download it. Sources stay in BWRAP_SOURCES order (upstream, then the R2
// mirror) and acquireSandbox accepts the first reachable source whose bytes
// match BWRAP_SHA. CI must not block on a single host outage when a verified
// fallback exists. A reachable source that serves different bytes is INTEGRITY
// and is not skipped for a later source that agrees. apparmor-profile still
// has one URL and is verified on its own.
export const dependencies = [
  { name: 'bubblewrap', urls: BWRAP_SOURCES, sha256: BWRAP_SHA },
  { name: 'apparmor-profile', url: APPARMOR_URL, sha256: APPARMOR_SHA, limit: 16384 },
];
/**
 * Two failures live here and they call for opposite responses.
 *
 * The host being unreachable means wait and retry: the artifact is fine and
 * somebody else's server is not. A digest that does not match means the bytes
 * at a pinned URL changed, which is a supply-chain event and must never be
 * retried away or skipped for another source that happens to agree. On
 * 2026-09-22 snapshot.ubuntu.com returned 503 for hours. For a multi-source
 * artifact that is an outage of one host: UNAVAILABLE only when no source can
 * be fetched, and a verified fallback is enough to pass.
 */
async function verifyFallbackSources(dependency, request) {
  const notes = [];
  try {
    const bytes = await acquireSandbox(request, dependency.urls, dependency.sha256, message => notes.push(message));
    return { name: dependency.name, bytes: bytes.length, sha256: dependency.sha256 };
  } catch (error) {
    const detail = notes.join(' ');
    if (error.message === 'integrity_failed') throw Error(`INTEGRITY: ${dependency.name}: ${detail}`);
    if (error.message === 'unavailable') throw Error(`UNAVAILABLE: ${dependency.name}: ${detail}`);
    throw error;
  }
}
export async function verifyDependency(dependency, request = fetch) {
  if (Array.isArray(dependency.urls)) return verifyFallbackSources(dependency, request);
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
