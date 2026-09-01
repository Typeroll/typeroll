#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

import { validateSelfHostEnvironment } from './lib/self-host-environment.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string', default: '.env' },
  },
});
const envPath = path.resolve(values['env-file']);

if (!fs.existsSync(envPath)) {
  console.error(`Self-host environment check failed: ${envPath} does not exist.`);
  console.error('Copy .env.self-host.example to .env and fill in every required value.');
  process.exit(1);
}

let env;
try {
  env = parseEnv(fs.readFileSync(envPath, 'utf8'));
} catch (error) {
  console.error(`Self-host environment check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const result = validateSelfHostEnvironment(env);
if (process.platform !== 'win32') {
  const permissions = fs.statSync(envPath).mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    result.errors.push(`${path.basename(envPath)}: permissions must be 0600 so group and other users cannot read secrets`);
    result.ok = false;
  }
}
for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
if (!result.ok) {
  console.error('Self-host environment check failed:');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Self-host environment check passed. Required values are present and internally consistent.');
