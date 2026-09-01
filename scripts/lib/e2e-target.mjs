const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for a remote E2E target`);
  return value;
}

function normalizedUrl(input, key, remote) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  if (remote && url.protocol !== 'https:') throw new Error(`${key} must use HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must not contain credentials, a query, or a fragment`);
  }
  return url.origin;
}

export function resolveE2ETarget(env = process.env) {
  const kind = env.TYPEROLL_E2E_TARGET?.trim() || 'local';
  if (!['local', 'self_host', 'cloud'].includes(kind)) {
    throw new Error('TYPEROLL_E2E_TARGET must be local, self_host, or cloud');
  }
  if (kind === 'local') {
    const portalUrl = normalizedUrl(env.TYPEROLL_E2E_PORTAL_URL ?? 'http://127.0.0.1:4322', 'TYPEROLL_E2E_PORTAL_URL', false);
    return {
      kind,
      portalUrl,
      formsUrl: normalizedUrl(env.TYPEROLL_E2E_FORMS_URL ?? portalUrl, 'TYPEROLL_E2E_FORMS_URL', false),
      firebaseApiKey: null,
      expectedDigest: null,
      isRemote: false,
    };
  }

  const portalUrl = normalizedUrl(required(env, 'TYPEROLL_E2E_PORTAL_URL'), 'TYPEROLL_E2E_PORTAL_URL', true);
  const formsUrl = normalizedUrl(required(env, 'TYPEROLL_E2E_FORMS_URL'), 'TYPEROLL_E2E_FORMS_URL', true);
  if (portalUrl === formsUrl) throw new Error('Remote portal and Forms origins must be separate');
  const expectedDigest = required(env, 'TYPEROLL_E2E_EXPECTED_DIGEST');
  if (!DIGEST_PATTERN.test(expectedDigest)) {
    throw new Error('TYPEROLL_E2E_EXPECTED_DIGEST must be an exact sha256 digest');
  }
  return {
    kind,
    portalUrl,
    formsUrl,
    firebaseApiKey: required(env, 'TYPEROLL_E2E_FIREBASE_API_KEY'),
    expectedDigest,
    isRemote: true,
  };
}

export async function checkE2ETarget(target, fetchImpl = fetch) {
  const requestJson = async (url) => {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  };
  const [health, ready, version, formsReady] = await Promise.all([
    requestJson(`${target.portalUrl}/api/healthz`),
    requestJson(`${target.portalUrl}/api/readyz`),
    requestJson(`${target.portalUrl}/api/version`),
    requestJson(`${target.formsUrl}/api/readyz`),
  ]);
  if (health.status !== 'ok') throw new Error('Portal liveness check did not report ok');
  if (ready.ready !== true) throw new Error('Portal readiness check did not report ready');
  if (formsReady.ready !== true) throw new Error('Forms readiness check did not report ready');
  if (target.expectedDigest && version.image_digest !== target.expectedDigest) {
    throw new Error(`Target reports image digest ${version.image_digest ?? 'missing'} instead of the expected digest`);
  }
  return { health, ready, version, formsReady };
}
