import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { validateSelfHostEnvironment } from './self-host-environment.mjs';

export function loadSelfHostEnvironment(envFile = '.env', processEnvironment = process.env) {
  const envPath = path.resolve(envFile);
  const fileExists = fs.existsSync(envPath);
  const fileEnvironment = fileExists ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  const env = { ...fileEnvironment, ...processEnvironment };
  const result = validateSelfHostEnvironment(env);
  if (fileExists && process.platform !== 'win32') {
    const permissions = fs.statSync(envPath).mode & 0o777;
    if ((permissions & 0o077) !== 0) {
      result.errors.push(`${path.basename(envPath)} permissions must be 0600`);
      result.ok = false;
    }
  }
  if (!result.ok) {
    if (!fileExists) result.errors.unshift(`${envPath} does not exist and the process environment is incomplete`);
    throw new Error(`self-host environment is invalid:\n${result.errors.map((error) => `- ${error}`).join('\n')}`);
  }
  return { env, envPath: fileExists ? envPath : null };
}

export function requireExactConfirmation(actual, supplied, label) {
  if (!supplied || supplied !== actual) {
    throw new Error(`${label} confirmation must exactly equal ${actual}`);
  }
}

export function reportError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
