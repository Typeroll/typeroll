/**
 * Seed the local E2E Worker's store with the fixture content.
 *
 * The suite runs against the built Worker in `wrangler dev --local`
 * (start-worker.mjs), whose documents live in Durable Objects under a fresh
 * temporary state directory per run. Only the Worker can reach those objects,
 * so global-setup.ts posts the documents to its local-E2E-only document route
 * (`/api/internal/e2e-store`, 404 unless local E2E mode is on).
 *
 * The documents are the committed fixtures tree in
 * `packages/site-template/fixtures` (read, never written), minus runtime-only
 * collections a developer's local portal may have left there, plus the
 * Core E2E personas and their fixture site.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPersonaDocuments } from '../../../../scripts/lib/e2e-personas.mjs';

const PORTAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_SOURCE = resolve(PORTAL_DIR, '..', 'site-template', 'fixtures');
const BATCH = 100;

/**
 * Collections that are runtime state rather than seed — the same set
 * `.gitignore` excludes from the fixtures tree. Copying them would let one
 * machine's leftover draft or API key change what the suite sees.
 */
const RUNTIME_ONLY = new Set([
  'user_organizations',
  'api_audit',
  'api_key_lookup',
  'api_keys',
  'deploys',
  'working_copies',
  'chat_messages',
]);

const isRuntimeOnly = (name) => RUNTIME_ONLY.has(name) || name.startsWith('_tombstones_');

/** Every fixture document as path → data, ready for the seeding route. */
export function localFixtureDocuments({ source = FIXTURES_SOURCE, now = () => new Date() } = {}) {
  if (!existsSync(join(source, 'organizations'))) throw new Error(`[e2e-seed] no fixtures found at ${source}`);
  const documents = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (isRuntimeOnly(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const path = relative(source, absolute).slice(0, -'.json'.length).split(sep).join('/');
        documents.set(path, JSON.parse(readFileSync(absolute, 'utf8')));
      }
    }
  };
  walk(source);
  // The local editor uses default/default as the development user. With the
  // Cloud access policy enabled, its owning organization must still be a real
  // record. Leave service_access absent to exercise existing-organization
  // compatibility.
  documents.set('organizations/default', {
    id: 'default', name: 'Local fixture organization', created_at: '2026-01-01T00:00:00Z',
  });
  for (const [path, data] of localPersonaDocuments({ now })) documents.set(path, data);
  return documents;
}

/** One request to the local E2E Worker's document route (src/lib/e2e-store.ts). */
export async function e2eStoreRequest({ portalUrl, secret, body, fetchImpl = fetch }) {
  if (!secret) throw new Error('[e2e-store] TYPEROLL_E2E_AUTH_SECRET is required');
  const response = await fetchImpl(new URL('/api/internal/e2e-store', portalUrl), {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Origin: new URL(portalUrl).origin, 'x-typeroll-e2e-secret': secret },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`[e2e-store] ${body.action} returned ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/** Post the fixture documents to the running local E2E Worker. */
export async function seedLocalStore({ portalUrl, secret, documents = localFixtureDocuments(), fetchImpl = fetch }) {
  const entries = [...documents].map(([path, data]) => ({ path, data }));
  // Organizations first: a site's document mirrors into its organization's object.
  entries.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  let written = 0;
  for (let index = 0; index < entries.length; index += BATCH) {
    const result = await e2eStoreRequest({ portalUrl, secret, fetchImpl, body: { action: 'set', documents: entries.slice(index, index + BATCH) } });
    written += result.written;
  }
  return { written };
}

/**
 * Write documents as a JSON fixtures tree (`<path>.json`), the input the
 * static site build reads with TYPEROLL_FIXTURES_DIR. Specs that build a site
 * outside the Worker use it with the seeded documents plus their own.
 */
export function writeFixtureTree(destination, documents) {
  const root = resolve(destination);
  for (const [path, data] of documents) {
    const file = resolve(root, `${path}.json`);
    if (!file.startsWith(`${root}${sep}`)) throw new Error(`[e2e-seed] ${path} escapes the fixtures tree`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
}
