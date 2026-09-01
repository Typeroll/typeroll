export const SELF_HOST_REQUIRED_KEYS = [
  'TYPEROLL_IMAGE',
  'TYPEROLL_IMAGE_DIGEST',
  'TYPEROLL_PORTAL_HOST',
  'TYPEROLL_FORMS_HOST',
  'TYPEROLL_ACME_EMAIL',
  'FIREBASE_SERVICE_ACCOUNT',
  'PUBLIC_FIREBASE_API_KEY',
  'PUBLIC_FIREBASE_AUTH_DOMAIN',
  'PUBLIC_FIREBASE_PROJECT_ID',
  'PUBLIC_FIREBASE_APP_ID',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'SITES_BASE_DOMAIN',
  'FORMS_HMAC_SECRET',
  'PREVIEW_HMAC_SECRET',
  'INTEGRATIONS_SECRET_KEY',
  'MCP_OAUTH_SIGNING_KEY',
  'EXTENSION_SIGNING_PRIVATE_JWK',
];

const SECRET_KEYS = new Set([
  'FIREBASE_SERVICE_ACCOUNT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_API_TOKEN',
  'FORMS_HMAC_SECRET',
  'PREVIEW_HMAC_SECRET',
  'INTEGRATIONS_SECRET_KEY',
  'MCP_OAUTH_SIGNING_KEY',
  'EXTENSION_SIGNING_PRIVATE_JWK',
  'ANTHROPIC_API_KEY',
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IMAGE_BY_DIGEST = /^\S+@sha256:[a-f0-9]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PLACEHOLDER = /(?:replace[-_ ]?me|your[-_ ]|<[^>]+>|\.\.\.)/i;

function value(env, key) {
  return typeof env[key] === 'string' ? env[key].trim() : '';
}

function isPlaceholder(input) {
  return PLACEHOLDER.test(input) || /^0+$/.test(input.replace(/^sha256:/, ''));
}

function validHttpsUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function validateSelfHostEnvironment(env) {
  const errors = [];
  const warnings = [];

  for (const key of SELF_HOST_REQUIRED_KEYS) {
    const input = value(env, key);
    if (!input) errors.push(`${key}: missing required value`);
    else if (isPlaceholder(input)) errors.push(`${key}: replace the example placeholder`);
  }

  const image = value(env, 'TYPEROLL_IMAGE');
  const digest = value(env, 'TYPEROLL_IMAGE_DIGEST');
  if (image && !IMAGE_BY_DIGEST.test(image)) errors.push('TYPEROLL_IMAGE: must use an immutable @sha256 digest');
  if (digest && !SHA256.test(digest)) errors.push('TYPEROLL_IMAGE_DIGEST: must be sha256 followed by 64 lowercase hex characters');
  if (image && digest && IMAGE_BY_DIGEST.test(image) && !image.endsWith(`@${digest}`)) {
    errors.push('TYPEROLL_IMAGE_DIGEST: does not match TYPEROLL_IMAGE');
  }

  for (const key of ['TYPEROLL_PORTAL_HOST', 'TYPEROLL_FORMS_HOST', 'PUBLIC_FIREBASE_AUTH_DOMAIN', 'SITES_BASE_DOMAIN']) {
    const input = value(env, key).toLowerCase();
    if (input && !HOSTNAME.test(input)) errors.push(`${key}: must be a DNS hostname without scheme or path`);
  }
  if (value(env, 'TYPEROLL_PORTAL_HOST') === value(env, 'TYPEROLL_FORMS_HOST')) {
    errors.push('TYPEROLL_FORMS_HOST: must be different from TYPEROLL_PORTAL_HOST');
  }

  const email = value(env, 'TYPEROLL_ACME_EMAIL');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('TYPEROLL_ACME_EMAIL: must be an email address');
  const cdn = value(env, 'R2_PUBLIC_BASE_URL');
  if (cdn && !validHttpsUrl(cdn)) errors.push('R2_PUBLIC_BASE_URL: must be an HTTPS URL without embedded credentials');

  const firebase = parseJson(value(env, 'FIREBASE_SERVICE_ACCOUNT'));
  if (value(env, 'FIREBASE_SERVICE_ACCOUNT')) {
    if (!firebase || typeof firebase !== 'object') errors.push('FIREBASE_SERVICE_ACCOUNT: must be valid single-line JSON');
    else {
      for (const field of ['project_id', 'client_email', 'private_key']) {
        if (typeof firebase[field] !== 'string' || !firebase[field].trim()) {
          errors.push(`FIREBASE_SERVICE_ACCOUNT: missing ${field}`);
        }
      }
      if (firebase.project_id && value(env, 'PUBLIC_FIREBASE_PROJECT_ID') && firebase.project_id !== value(env, 'PUBLIC_FIREBASE_PROJECT_ID')) {
        errors.push('PUBLIC_FIREBASE_PROJECT_ID: must match FIREBASE_SERVICE_ACCOUNT.project_id');
      }
    }
  }

  for (const key of ['FORMS_HMAC_SECRET', 'PREVIEW_HMAC_SECRET', 'INTEGRATIONS_SECRET_KEY', 'MCP_OAUTH_SIGNING_KEY']) {
    const input = value(env, key);
    if (input && input.length < 32) errors.push(`${key}: must be at least 32 characters`);
  }

  const extensionJwk = parseJson(value(env, 'EXTENSION_SIGNING_PRIVATE_JWK'));
  if (value(env, 'EXTENSION_SIGNING_PRIVATE_JWK')) {
    if (!extensionJwk || typeof extensionJwk !== 'object') {
      errors.push('EXTENSION_SIGNING_PRIVATE_JWK: must be valid single-line JSON');
    } else if (
      extensionJwk.kty !== 'EC' || extensionJwk.crv !== 'P-256' ||
      !extensionJwk.x || !extensionJwk.y || !extensionJwk.d
    ) {
      errors.push('EXTENSION_SIGNING_PRIVATE_JWK: must be a P-256 private EC JWK with x, y, and d');
    }
  }

  if (!value(env, 'ANTHROPIC_API_KEY')) warnings.push('ANTHROPIC_API_KEY: AI chat will be disabled');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    secretKeys: [...SECRET_KEYS],
  };
}
