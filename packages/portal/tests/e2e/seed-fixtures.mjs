#!/usr/bin/env node
/**
 * Seed a throwaway fixtures tree for the e2e run.
 *
 * The bundled `packages/site-template/fixtures/` tree is committed seed
 * content AND the live datastore whenever the portal runs without a
 * Firestore service account — so an e2e run that drives the real editor
 * wrote its saves, revision snapshots and forms straight into tracked
 * files. `git status` was dirty after every `npx playwright test`, and
 * the damage couldn't be gitignored away: `pages/home.json` is genuine
 * seed, and the per-page `revisions/` folders hold committed snapshots
 * the smoke build and docs rely on.
 *
 * So the run gets its own copy instead. playwright.config.ts computes the
 * destination, passes it here as argv[2], and hands the same path to the
 * dev server as TYPEROLL_FIXTURES_DIR — every write the suite provokes
 * lands there. Same isolation the vitest suite gets from
 * `makeTmpFixtures()`, one level up.
 *
 * Usage: node ./tests/e2e/seed-fixtures.mjs <destination-dir>
 */

import { cpSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PORTAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = resolve(PORTAL_DIR, '..', 'site-template', 'fixtures');

/**
 * Collections that are runtime state rather than seed — the same set
 * `.gitignore` excludes from the fixtures tree. A developer who has used
 * the local portal has these lying around; copying them would let one
 * machine's leftover draft or API key change what the suite sees. A
 * fresh checkout has none of them, and that's the shape we want to test
 * against.
 */
const RUNTIME_ONLY = new Set([
  'api_audit',
  'api_key_lookup',
  'api_keys',
  'deploys',
  'working_copies',
]);

function isRuntimeOnly(path) {
  const name = basename(path);
  return RUNTIME_ONLY.has(name) || name.startsWith('_tombstones_');
}

const dest = process.argv[2];
if (!dest) {
  console.error('[e2e-seed] missing destination argument');
  process.exit(1);
}

if (!existsSync(join(SOURCE, 'organizations'))) {
  // The fixtures resolver keys off an `organizations/` directory; without
  // it the dev server would silently fall back to searching upward and
  // find the repo tree we're trying to keep out of.
  console.error(`[e2e-seed] no fixtures found at ${SOURCE}`);
  process.exit(1);
}

// The destination is about to be deleted recursively, and it arrives as a bare
// argv. playwright.config.ts always passes a path under os.tmpdir(), but this
// script is runnable by hand — `node seed-fixtures.mjs .` would wipe the
// working tree without asking. The source is already validated below; the
// destination deserves the same care, since getting it wrong is unrecoverable
// rather than merely wrong.
const resolvedDest = resolve(dest);
// Every spelling of "somewhere temporary" a caller might legitimately hold:
// os.tmpdir() (what playwright.config.ts passes), its realpath — on macOS
// os.tmpdir() is /var/folders/… which realpaths to /private/var/folders/… —
// and conventional /tmp, which on macOS is a symlink to /private/tmp and is
// NOT under os.tmpdir() at all.
const tmpRoots = [...new Set([
  resolve(tmpdir()),
  realpathSync(tmpdir()),
  ...(existsSync('/tmp') ? ['/tmp', realpathSync('/tmp')] : []),
])];
// `startsWith(root + sep)` and not `startsWith(root)`: the latter would also
// accept the temp root ITSELF, i.e. wiping all of /tmp.
if (!tmpRoots.some((root) => resolvedDest.startsWith(root + sep))) {
  console.error(
    `[e2e-seed] refusing to wipe ${resolvedDest} — the destination must be inside ${tmpRoots[0]}`,
  );
  process.exit(1);
}

rmSync(resolvedDest, { recursive: true, force: true });
cpSync(SOURCE, dest, { recursive: true, filter: (src) => !isRuntimeOnly(src) });

console.log(`[e2e-seed] seeded ${dest} from ${SOURCE}`);
