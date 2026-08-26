// Per-test fixtures dir. Each test that needs a writable datastore calls
// `makeTmpFixtures()` to get its own isolated tree under `os.tmpdir()`,
// then points TYPEROLL_FIXTURES_DIR at it and resets the datastore
// singleton so its choice is re-evaluated. The afterEach in vitest.setup
// removes every dir we created.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = new Set<string>();

export const tmpDir = {
  allCreated(): string[] {
    return Array.from(created);
  },
  reset(): void {
    created.clear();
  },
};

export function makeTmpFixtures(): { dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-test-'));
  // The fixtures resolver searches upward for a folder containing
  // `organizations/`. Create the marker so it doesn't escape our root.
  fs.mkdirSync(path.join(root, 'organizations'), { recursive: true });
  created.add(root);
  process.env.TYPEROLL_FIXTURES_DIR = root;
  return { dir: root };
}

/** Reset the in-module-singleton datastore cached by lib/datastore.ts so a
 *  fresh TYPEROLL_FIXTURES_DIR actually takes effect. */
export async function resetDatastore(): Promise<void> {
  const mod = (await import('../../lib/datastore.js')) as unknown as {
    _resetForTests?: () => void;
  };
  mod._resetForTests?.();
}
