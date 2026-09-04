import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRemoteApiKeyDocuments,
  corePersonas,
  readPersonaManifest,
  readSecurePersonaEnvFile,
  remotePersonaCredentials,
  remoteApiKeyCredential,
  resolveFirebasePersonaTarget,
  seedLocalPersonas,
  seedRemotePersonas,
  validatePersonaManifest,
  verifyLocalPersonas,
  verifyRemotePersonas,
} from './lib/e2e-personas.mjs';

function remoteEnvironment(manifest) {
  const env = {
    TYPEROLL_E2E_API_KEY: `typeroll_live_${'a'.repeat(12)}_${'b'.repeat(48)}`,
  };
  for (const persona of corePersonas(manifest)) {
    env[persona.email_env] = `${persona.id}@self-host.e2e.example.test`;
    env[persona.password_env] = `${persona.id}-` + 'p'.repeat(40);
  }
  return env;
}

function memoryServices() {
  const users = new Map();
  const documents = new Map();
  return {
    state: { users, documents },
    services: {
      projectId: 'typeroll-self-host-e2e',
      auth: {
        upsert: async (user) => users.set(user.uid, structuredClone(user)),
        get: async (uid) => users.has(uid) ? structuredClone(users.get(uid)) : null,
        verifyPassword: async (email, password) => {
          const user = [...users.values()].find((candidate) => candidate.email === email);
          if (!user || user.password !== password) throw new Error('invalid credentials');
        },
      },
      firestore: {
        setDocuments: async (records) => {
          for (const record of records) documents.set(record.path, structuredClone(record.data));
        },
        get: async (documentPath) => documents.has(documentPath) ? structuredClone(documents.get(documentPath)) : null,
      },
    },
  };
}

test('persona manifest separates Core identities from private Cloud identities', () => {
  const manifest = readPersonaManifest();
  assert.deepEqual(corePersonas(manifest).map((persona) => persona.id), ['owner', 'editor', 'viewer', 'outsider', 'pending']);
  assert.equal(manifest.personas.find((persona) => persona.id === 'operator').managed_by, 'cloud_control_plane');
  assert.equal(manifest.personas.find((persona) => persona.id === 'app_entitled').managed_by, 'cloud_apps');
  assert.throws(
    () => validatePersonaManifest({ ...manifest, personas: manifest.personas.filter((persona) => persona.id !== 'pending') }),
    /missing pending/,
  );
});

test('remote credential contract requires unique injected values of sufficient length', () => {
  const manifest = readPersonaManifest();
  const env = remoteEnvironment(manifest);
  assert.equal(remotePersonaCredentials(manifest, env).owner.email, 'owner@self-host.e2e.example.test');
  assert.throws(() => remotePersonaCredentials(manifest, { ...env, TYPEROLL_E2E_OWNER_PASSWORD: 'short' }), /at least 32/);
  assert.throws(() => remotePersonaCredentials(manifest, { ...env, TYPEROLL_E2E_OWNER_EMAIL: 'not-an-email' }), /email address/);
  assert.throws(() => remotePersonaCredentials(manifest, {
    ...env,
    TYPEROLL_E2E_EDITOR_EMAIL: env.TYPEROLL_E2E_OWNER_EMAIL.toUpperCase(),
  }), /email addresses must be unique/);
  assert.throws(() => remotePersonaCredentials(manifest, {
    ...env,
    TYPEROLL_E2E_EDITOR_PASSWORD: env.TYPEROLL_E2E_OWNER_PASSWORD,
  }), /passwords must be unique/);
  assert.equal(remoteApiKeyCredential(env).prefix, 'a'.repeat(12));
  assert.throws(() => remoteApiKeyCredential({ TYPEROLL_E2E_API_KEY: 'invalid' }), /valid site-scoped/);
  const keyDocuments = buildRemoteApiKeyDocuments(manifest, env, () => new Date(0));
  assert.equal(keyDocuments.get(`api_key_lookup/${'a'.repeat(12)}`).site_id, 'e2e-core-site');
});

test('credential files must be private before they are parsed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typeroll-persona-env-'));
  const envFile = path.join(directory, 'personas.env');
  try {
    fs.writeFileSync(envFile, 'TYPEROLL_E2E_OWNER_EMAIL=owner@example.test\n', { mode: 0o600 });
    assert.equal(readSecurePersonaEnvFile(envFile, {}).TYPEROLL_E2E_OWNER_EMAIL, 'owner@example.test');
    fs.chmodSync(envFile, 0o644);
    assert.throws(() => readSecurePersonaEnvFile(envFile, {}), /mode 0600/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('remote persona administration supports service-account and keyless ADC targets', () => {
  assert.deepEqual(
    resolveFirebasePersonaTarget({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'service-account-project' }) }),
    {
      projectId: 'service-account-project',
      credentialKind: 'service_account',
      credentials: { project_id: 'service-account-project' },
    },
  );
  assert.deepEqual(
    resolveFirebasePersonaTarget({ GOOGLE_CLOUD_PROJECT: 'adc-project' }),
    { projectId: 'adc-project', credentialKind: 'application_default', credentials: null },
  );
  assert.throws(() => resolveFirebasePersonaTarget({ FIREBASE_SERVICE_ACCOUNT: '{' }), /valid JSON/);
  assert.throws(() => resolveFirebasePersonaTarget({}), /Application Default Credentials/);
});

test('local seeding is idempotent and produces the role and sharing baseline', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'typeroll-personas-'));
  try {
    const first = seedLocalPersonas({ fixtureRoot, now: () => new Date('2026-09-01T00:00:00.000Z') });
    const second = seedLocalPersonas({ fixtureRoot, now: () => new Date('2026-09-01T00:00:00.000Z') });
    assert.deepEqual(second, first);
    assert.equal(verifyLocalPersonas({ fixtureRoot }).personaCount, 5);
    const editor = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'organizations/e2e-core/members/typeroll-e2e-editor.json'), 'utf8'));
    const share = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'org_share_index/e2e-viewer/shares/e2e-viewer.json'), 'utf8'));
    assert.equal(editor.role, 'editor');
    assert.equal(share.permission, 'read');
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'organizations/e2e-core/sites/e2e-core-site/versions/main/pages/home.json')), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('remote seeding upserts stable users, claims, documents, and verifies password login', async () => {
  const manifest = readPersonaManifest();
  const env = remoteEnvironment(manifest);
  const memory = memoryServices();
  const first = await seedRemotePersonas({ services: memory.services, env, manifest });
  const second = await seedRemotePersonas({ services: memory.services, env, manifest });
  assert.equal(first.personaCount, 5);
  assert.deepEqual(second, first);
  assert.equal(memory.state.users.get('typeroll-e2e-pending').customClaims.org_id, undefined);
  assert.equal(memory.state.users.get('typeroll-e2e-owner').customClaims.is_test_account, true);
  assert.equal(memory.state.documents.get('organizations/e2e-core').roles_enforced, true);
  assert.equal(memory.state.documents.get('organizations/e2e-core/sites/e2e-core-site/shares/e2e-viewer').permission, 'read');
  assert.equal(memory.state.documents.get(`api_key_lookup/${'a'.repeat(12)}`).is_test_credential, true);

  memory.state.users.get('typeroll-e2e-editor').customClaims.org_id = 'wrong-org';
  await assert.rejects(verifyRemotePersonas({ services: memory.services, env, manifest }), /editor: org claim differs/);
});
