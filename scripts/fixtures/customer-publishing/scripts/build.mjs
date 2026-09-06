import './verify-publication.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url)), 'build'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
  timeout: 10 * 60 * 1000,
});
if (result.error) throw new Error('Static publication build did not complete');
process.exitCode = result.status ?? 1;
