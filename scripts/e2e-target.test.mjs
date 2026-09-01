import assert from 'node:assert/strict';
import test from 'node:test';

import { checkE2ETarget, resolveE2ETarget } from './lib/e2e-target.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

test('resolves an isolated local target without remote credentials', () => {
  assert.deepEqual(resolveE2ETarget({}), {
    kind: 'local',
    portalUrl: 'http://127.0.0.1:4322',
    formsUrl: 'http://127.0.0.1:4322',
    firebaseApiKey: null,
    expectedDigest: null,
    isRemote: false,
  });
});

test('requires separate HTTPS origins and an immutable digest remotely', () => {
  const env = {
    TYPEROLL_E2E_TARGET: 'self_host',
    TYPEROLL_E2E_PORTAL_URL: 'https://cms.e2e.example.test/path',
    TYPEROLL_E2E_FORMS_URL: 'https://forms.e2e.example.test',
    TYPEROLL_E2E_FIREBASE_API_KEY: 'public-api-key',
    TYPEROLL_E2E_EXPECTED_DIGEST: DIGEST,
  };
  assert.equal(resolveE2ETarget(env).portalUrl, 'https://cms.e2e.example.test');
  assert.throws(() => resolveE2ETarget({ ...env, TYPEROLL_E2E_FORMS_URL: env.TYPEROLL_E2E_PORTAL_URL }), /separate/);
  assert.throws(() => resolveE2ETarget({ ...env, TYPEROLL_E2E_PORTAL_URL: 'http://cms.test' }), /HTTPS/);
  assert.throws(() => resolveE2ETarget({ ...env, TYPEROLL_E2E_EXPECTED_DIGEST: 'latest' }), /exact sha256/);
});

test('checks both service origins and rejects digest drift', async () => {
  const target = resolveE2ETarget({
    TYPEROLL_E2E_TARGET: 'cloud',
    TYPEROLL_E2E_PORTAL_URL: 'https://cloud.e2e.example.test',
    TYPEROLL_E2E_FORMS_URL: 'https://forms.cloud.e2e.example.test',
    TYPEROLL_E2E_FIREBASE_API_KEY: 'public-api-key',
    TYPEROLL_E2E_EXPECTED_DIGEST: DIGEST,
  });
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => url.endsWith('/api/version')
      ? { core_version: '0.1.0', image_digest: DIGEST }
      : url.endsWith('/healthz') ? { status: 'ok' } : { ready: true },
  });
  assert.equal((await checkE2ETarget(target, fetchImpl)).version.image_digest, DIGEST);
  await assert.rejects(
    checkE2ETarget(target, async (url) => ({
      ok: true,
      json: async () => url.endsWith('/api/version')
        ? { image_digest: `sha256:${'b'.repeat(64)}` }
        : url.endsWith('/healthz') ? { status: 'ok' } : { ready: true },
    })),
    /instead of the expected digest/,
  );
});
