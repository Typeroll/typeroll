import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRemoteApiKeyDocuments,
  corePersonas,
  createEndpointPersonaServices,
  readPersonaManifest,
  readSecurePersonaEnvFile,
  remotePersonaCredentials,
  remoteApiKeyCredential,
  resolvePersonaEndpoint,
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

// The seeding endpoint's contract: accounts keyed by uid, documents by path,
// `preserve` fields kept from the stored document.
function memoryServices() {
  const users = new Map();
  const documents = new Map();
  return {
    state: { users, documents },
    services: {
      target: 'operator.e2e.example.test',
      seed: async ({ personas, documents: records }) => {
        for (const persona of personas) {
          users.set(persona.uid, { ...structuredClone(persona), email: persona.email.toLowerCase(), testAccount: true, emailVerified: true, disabled: false });
        }
        for (const record of records) {
          const data = structuredClone(record.data);
          for (const field of record.preserve ?? []) {
            if (documents.get(record.path)?.[field] !== undefined) data[field] = documents.get(record.path)[field];
          }
          documents.set(record.path, data);
        }
      },
      inspect: async ({ personas, paths }) => ({
        personas: personas.map((persona) => {
          const user = users.get(persona.uid);
          return {
            persona: persona.persona,
            uid: persona.uid,
            exists: !!user,
            email: user?.email ?? null,
            emailVerified: user?.emailVerified === true,
            disabled: user?.disabled === true,
            testAccount: user?.testAccount === true && user?.persona === persona.persona,
            passwordValid: user?.password === persona.password,
          };
        }),
        documents: Object.fromEntries(paths.map((documentPath) => [documentPath, documents.has(documentPath) ? structuredClone(documents.get(documentPath)) : null])),
      }),
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

test('remote personas are seeded only through an HTTPS endpoint with a dedicated token', async () => {
  const token = 't'.repeat(40);
  assert.deepEqual(
    resolvePersonaEndpoint({ TYPEROLL_E2E_SEED_URL: 'https://operator.e2e.example.test/api/e2e-personas', TYPEROLL_E2E_SEED_TOKEN: token }),
    { url: 'https://operator.e2e.example.test/api/e2e-personas', host: 'operator.e2e.example.test', token },
  );
  assert.throws(() => resolvePersonaEndpoint({ TYPEROLL_E2E_SEED_URL: 'http://operator.e2e.example.test/x', TYPEROLL_E2E_SEED_TOKEN: token }), /HTTPS/);
  assert.throws(() => resolvePersonaEndpoint({ TYPEROLL_E2E_SEED_URL: 'https://operator.e2e.example.test/x?token=1', TYPEROLL_E2E_SEED_TOKEN: token }), /query/);
  assert.throws(() => resolvePersonaEndpoint({ TYPEROLL_E2E_SEED_URL: 'https://operator.e2e.example.test/x', TYPEROLL_E2E_SEED_TOKEN: 'short' }), /at least 32/);
  assert.throws(() => resolvePersonaEndpoint({}), /TYPEROLL_E2E_SEED_URL/);

  const requests = [];
  const services = createEndpointPersonaServices(
    { TYPEROLL_E2E_SEED_URL: 'https://operator.e2e.example.test/api/e2e-personas', TYPEROLL_E2E_SEED_TOKEN: token },
    async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ personas: [], documents: {} }), { status: 200 });
    },
  );
  assert.equal(services.target, 'operator.e2e.example.test');
  await services.inspect({ personas: [], paths: ['organizations/e2e-core'] });
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].init.body), { action: 'inspect', personas: [], paths: ['organizations/e2e-core'] });

  const refused = createEndpointPersonaServices(
    { TYPEROLL_E2E_SEED_URL: 'https://operator.e2e.example.test/api/e2e-personas', TYPEROLL_E2E_SEED_TOKEN: token },
    async () => new Response('Not found', { status: 404 }),
  );
  await assert.rejects(refused.seed({ personas: [], documents: [] }), (error) => /missing route or wrong token/.test(error.message) && !error.message.includes(token));
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
    const site = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'organizations/e2e-core/sites/e2e-core-site.json'), 'utf8'));
    assert.equal(site.slug, 'e2e-core-site');
    assert.equal(site.domain, undefined);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('remote seeding upserts stable accounts, membership indexes and documents, and verifies password login', async () => {
  const manifest = readPersonaManifest();
  const env = remoteEnvironment(manifest);
  const memory = memoryServices();
  const first = await seedRemotePersonas({ services: memory.services, env, manifest });
  const second = await seedRemotePersonas({ services: memory.services, env, manifest });
  assert.equal(first.personaCount, 5);
  assert.deepEqual(second, first);
  assert.equal(memory.state.users.get('typeroll-e2e-owner').name, 'E2E owner');
  assert.equal(memory.state.documents.get('organizations/e2e-core').roles_enforced, true);
  assert.equal(memory.state.documents.get('organizations/e2e-core/sites/e2e-core-site/shares/e2e-viewer').permission, 'read');
  assert.deepEqual(memory.state.documents.get('user_organizations/typeroll-e2e-editor/organizations/e2e-core'), { org_id: 'e2e-core' });
  assert.equal(memory.state.documents.has('user_organizations/typeroll-e2e-pending'), false);
  assert.equal(memory.state.documents.get(`api_key_lookup/${'a'.repeat(12)}`).is_test_credential, true);
  assert.equal(memory.state.documents.get('organizations/e2e-core/sites/e2e-core-site').hosting_config, undefined);

  memory.state.users.get('typeroll-e2e-editor').password = 'rotated elsewhere';
  memory.state.documents.delete('user_organizations/typeroll-e2e-viewer/organizations/e2e-viewer');
  await assert.rejects(
    verifyRemotePersonas({ services: memory.services, env, manifest }),
    /editor: password login failed[\s\S]*user_organizations\/typeroll-e2e-viewer\/organizations\/e2e-viewer: missing/,
  );
});
