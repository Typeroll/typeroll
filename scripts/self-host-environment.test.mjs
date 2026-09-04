import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  SELF_HOST_REQUIRED_KEYS,
  validateSelfHostEnvironment,
} from './lib/self-host-environment.mjs';
import { loadSelfHostEnvironment } from './lib/self-host-cli.mjs';

function validEnvironment() {
  const digest = `sha256:${'a'.repeat(64)}`;
  return {
    TYPEROLL_IMAGE: `ghcr.io/typeroll/typeroll@${digest}`,
    TYPEROLL_IMAGE_DIGEST: digest,
    TYPEROLL_PORTAL_HOST: 'cms.example.test',
    TYPEROLL_FORMS_HOST: 'forms.example.test',
    TYPEROLL_ACME_EMAIL: 'ops@example.test',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      project_id: 'typeroll-self-host',
      client_email: 'firebase@example.test',
      private_key: 'test-only-private-key',
    }),
    PUBLIC_FIREBASE_API_KEY: 'public-test-key',
    PUBLIC_FIREBASE_AUTH_DOMAIN: 'typeroll-self-host.firebaseapp.com',
    PUBLIC_FIREBASE_PROJECT_ID: 'typeroll-self-host',
    PUBLIC_FIREBASE_APP_ID: 'test-app-id',
    R2_ACCOUNT_ID: 'r2-account',
    R2_ACCESS_KEY_ID: 'r2-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    R2_BUCKET: 'typeroll-media',
    R2_PUBLIC_BASE_URL: 'https://media.example.test',
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account',
    CLOUDFLARE_API_TOKEN: 'cloudflare-token',
    SITES_BASE_DOMAIN: 'sites.example.test',
    FORMS_HMAC_SECRET: 'f'.repeat(32),
    PREVIEW_HMAC_SECRET: 'p'.repeat(32),
    INTEGRATIONS_SECRET_KEY: 'i'.repeat(32),
    MCP_OAUTH_SIGNING_KEY: 'm'.repeat(32),
    TYPEROLL_BACKUP_KEY: Buffer.alloc(32, 7).toString('base64url'),
    EXTENSION_SIGNING_PRIVATE_JWK: JSON.stringify({
      kty: 'EC', crv: 'P-256', x: 'test-x', y: 'test-y', d: 'test-d',
    }),
  };
}

function writeEnvironmentFile(env, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typeroll-self-host-'));
  const envPath = path.join(directory, '.env');
  const content = Object.entries(env)
    .map(([key, input]) => `${key}='${String(input).replaceAll("'", "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(envPath, `${content}\n`, { mode });
  return { directory, envPath };
}

function runDoctor(envPath) {
  return spawnSync(process.execPath, [
    new URL('./self-host-doctor.mjs', import.meta.url).pathname,
    '--env-file',
    envPath,
  ], { encoding: 'utf8' });
}

test('accepts a complete immutable self-host environment', () => {
  const result = validateSelfHostEnvironment(validEnvironment());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('accepts keyless Google credentials for self-host operations', () => {
  const env = validEnvironment();
  delete env.FIREBASE_SERVICE_ACCOUNT;
  env.GOOGLE_CLOUD_PROJECT = env.PUBLIC_FIREBASE_PROJECT_ID;

  const result = validateSelfHostEnvironment(env);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('loads a complete self-host contract directly from the process environment', () => {
  const env = validEnvironment();
  const missingPath = path.join(os.tmpdir(), `typeroll-missing-${process.pid}-${Date.now()}`);

  const loaded = loadSelfHostEnvironment(missingPath, env);

  assert.equal(loaded.envPath, null);
  assert.equal(loaded.env.EXTENSION_SIGNING_PRIVATE_JWK, env.EXTENSION_SIGNING_PRIVATE_JWK);
});

test('process-injected secrets override values from the environment file', () => {
  const fileEnvironment = validEnvironment();
  fileEnvironment.TYPEROLL_BACKUP_KEY = 'invalid-file-value';
  fileEnvironment.EXTENSION_SIGNING_PRIVATE_JWK = 'invalid-file-value';
  const { directory, envPath } = writeEnvironmentFile(fileEnvironment, 0o600);
  const injected = validEnvironment();

  try {
    const loaded = loadSelfHostEnvironment(envPath, injected);
    assert.equal(loaded.envPath, envPath);
    assert.equal(loaded.env.TYPEROLL_BACKUP_KEY, injected.TYPEROLL_BACKUP_KEY);
    assert.equal(loaded.env.EXTENSION_SIGNING_PRIVATE_JWK, injected.EXTENSION_SIGNING_PRIVATE_JWK);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('requires one matching Firebase administration target', () => {
  const env = validEnvironment();
  delete env.FIREBASE_SERVICE_ACCOUNT;
  let result = validateSelfHostEnvironment(env);
  assert.ok(result.errors.some((error) => error.includes('GOOGLE_CLOUD_PROJECT')));

  env.GOOGLE_CLOUD_PROJECT = 'another-project';
  result = validateSelfHostEnvironment(env);
  assert.ok(result.errors.some((error) => error.includes('must match GOOGLE_CLOUD_PROJECT')));
});

test('rejects mutable images, mismatched Firebase projects, and short secrets', () => {
  const env = validEnvironment();
  env.TYPEROLL_IMAGE = 'ghcr.io/typeroll/typeroll:latest';
  env.PUBLIC_FIREBASE_PROJECT_ID = 'another-project';
  env.FORMS_HMAC_SECRET = 'short';
  env.TYPEROLL_BACKUP_KEY = 'not-valid-base64url';
  const result = validateSelfHostEnvironment(env);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('immutable @sha256')));
  assert.ok(result.errors.some((error) => error.includes('must match FIREBASE_SERVICE_ACCOUNT.project_id')));
  assert.ok(result.errors.some((error) => error.includes('FORMS_HMAC_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('TYPEROLL_BACKUP_KEY')));
});

test('the example file documents every required contract key', () => {
  const example = fs.readFileSync(new URL('../.env.self-host.example', import.meta.url), 'utf8');
  for (const key of SELF_HOST_REQUIRED_KEYS) assert.match(example, new RegExp(`^${key}=`, 'm'), key);
});

test('the Compose profile uses one immutable image for every Core role', () => {
  const compose = fs.readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /image: \$\{TYPEROLL_IMAGE:\?/);
  assert.match(compose, /SERVICE_ROLE: portal/);
  assert.match(compose, /SERVICE_ROLE: forms/);
  assert.match(compose, /SERVICE_ROLE: worker/);
  assert.match(compose, /DEPLOY_QUEUE: firestore/);
  assert.equal(compose.match(/TYPEROLL_BACKUP_KEY: ""/g)?.length, 3);
  assert.doesNotMatch(compose, /:latest\b/);
});

test('the doctor accepts a complete private environment file', () => {
  const { directory, envPath } = writeEnvironmentFile(validEnvironment(), 0o600);
  try {
    const result = runDoctor(envPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /environment check passed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the doctor rejects broad file permissions without printing secrets', { skip: process.platform === 'win32' }, () => {
  const env = validEnvironment();
  const { directory, envPath } = writeEnvironmentFile(env, 0o644);
  try {
    const result = runDoctor(envPath);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /permissions must be 0600/);
    assert.doesNotMatch(output, new RegExp(env.FORMS_HMAC_SECRET));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
