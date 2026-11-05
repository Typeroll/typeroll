#!/usr/bin/env node
/**
 * The local Playwright web server: build the portal Worker and run the built
 * bundle in `wrangler dev --local` on 127.0.0.1:<port>.
 *
 * Each run gets a fresh temporary directory holding
 *   - `.dev.vars` (mode 0600): the E2E-only variables playwright.config.ts
 *     passes as JSON in TYPEROLL_E2E_WORKER_VARS. A developer's own
 *     `packages/portal/.dev.vars` is never read (`--env-file` replaces it).
 *   - `state/`: the Durable Object storage, so every run starts from an empty
 *     store that global-setup.ts seeds through the local E2E seeding route.
 * The directory is created here rather than in the config because Playwright
 * evaluates the config again in every worker process. It is removed when the
 * server stops; directories a killed run left behind are removed on the next
 * start.
 *
 * Usage: node ./tests/e2e/start-worker.mjs <port>
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'typeroll-e2e-worker-';
const STALE_MS = 24 * 60 * 60 * 1000;

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024) {
  console.error('[e2e-worker] usage: start-worker.mjs <port>');
  process.exit(1);
}

let vars;
try {
  vars = JSON.parse(process.env.TYPEROLL_E2E_WORKER_VARS ?? '');
} catch {
  console.error('[e2e-worker] TYPEROLL_E2E_WORKER_VARS must be a JSON object');
  process.exit(1);
}
if (vars?.TYPEROLL_LOCAL_E2E !== 'allow' || vars.STORE_JURISDICTION !== 'none' || vars.AUTH_SECRET) {
  console.error('[e2e-worker] refusing to start: the variables do not describe local E2E mode');
  process.exit(1);
}

for (const entry of readdirSync(tmpdir())) {
  if (!entry.startsWith(PREFIX)) continue;
  const path = join(tmpdir(), entry);
  try { if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true }); } catch { /* another run's */ }
}

const runDir = mkdtempSync(join(tmpdir(), PREFIX));
const envFile = join(runDir, '.dev.vars');
// Single-quoted dotenv values are literal, so JSON values survive unchanged.
const quote = (value) => {
  const text = String(value);
  if (/['\r\n]/.test(text)) throw new Error('[e2e-worker] variable values must not contain quotes or line breaks');
  return `'${text}'`;
};
writeFileSync(envFile, Object.entries(vars).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n', { mode: 0o600 });
chmodSync(envFile, 0o600);

const cleanup = () => rmSync(runDir, { recursive: true, force: true });

if (process.env.TYPEROLL_E2E_SKIP_BUILD !== 'true') {
  const build = spawnSync('npm', ['run', 'build'], { cwd: PORTAL_DIR, stdio: 'inherit' });
  if (build.status !== 0) {
    cleanup();
    process.exit(build.status ?? 1);
  }
}

const child = spawn('npx', [
  'wrangler', 'dev',
  '--config', 'dist/server/wrangler.json',
  '--local',
  '--ip', '127.0.0.1',
  '--port', String(port),
  '--persist-to', join(runDir, 'state'),
  '--env-file', envFile,
  '--show-interactive-dev-session=false',
  '--live-reload=false',
], { cwd: PORTAL_DIR, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_SEND_METRICS: 'false' } });

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
}
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(stopping ? 0 : (code ?? (signal ? 1 : 0)));
});
