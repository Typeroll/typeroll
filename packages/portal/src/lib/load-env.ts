/**
 * Server-side .env loader. Imported once at app boot so process.env reflects
 * the values in packages/portal/.env regardless of what's already in the
 * shell. We use `override: true` because dev shells often have empty
 * placeholder values exported (e.g. ANTHROPIC_API_KEY="" injected by
 * desktop apps), which would otherwise mask the real value in .env.
 *
 * The lookup walks upward from cwd so the loader works no matter where the
 * dev server is launched from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

function findEnvFile(): string | null {
  let dir = process.cwd();
  // Walk up at most 4 levels — far enough to catch monorepo roots.
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envFile = findEnvFile();
if (envFile) {
  config({ path: envFile, override: true, quiet: true });
}
