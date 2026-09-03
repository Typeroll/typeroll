import crypto from 'node:crypto';
import {
  EXTENSION_HOST_PROTOCOL_VERSION,
  effectiveExtensionScopes,
  paths,
  type ExtensionApiRoute,
  type ExtensionInstallation,
  type Extension,
  type ExtensionLaunchGrant,
  type ExtensionScope,
  type InstallationCredential,
  type SharePermission,
} from '@typeroll/shared';
import { generateDocId, getStore } from '../datastore';
import { recordExtensionAudit } from './registry';
import { resolveExtensionVersion } from './resolution';

const LAUNCH_TTL_SECONDS = 60;
const USER_TOKEN_TTL_SECONDS = 5 * 60;
const PUBLIC_EXTENSION_TOKEN_TTL_SECONDS = 5 * 60;
const SERVICE_CREDENTIAL_BYTES = 32;

export class ExtensionAuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ExtensionAuthError';
  }
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

let ephemeralKeyPair: { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } | null = null;

function signingKey(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject; kid: string } {
  const configured = process.env.EXTENSION_SIGNING_PRIVATE_JWK;
  let privateKey: crypto.KeyObject;
  if (configured) {
    let jwk: crypto.JsonWebKey;
    try { jwk = JSON.parse(configured) as crypto.JsonWebKey; } catch { throw new ExtensionAuthError('EXTENSION_SIGNING_PRIVATE_JWK is invalid', 500); }
    privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new ExtensionAuthError('EXTENSION_SIGNING_PRIVATE_JWK is required in production', 500);
    }
    ephemeralKeyPair ??= crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = ephemeralKeyPair.privateKey;
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const publicJwk = publicKey.export({ format: 'jwk' });
  const kid = hash(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })).slice(0, 16);
  return { privateKey, publicKey, kid };
}

export function extensionIssuer(): string {
  const raw = process.env.PORTAL_PUBLIC_URL;
  if (!raw) throw new ExtensionAuthError('PORTAL_PUBLIC_URL is required for Extension auth', 500);
  try {
    const url = new URL(raw);
    if ((process.env.NODE_ENV === 'production' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new ExtensionAuthError('PORTAL_PUBLIC_URL must be a canonical origin', 500);
  }
}

export function extensionJwks(): { keys: crypto.JsonWebKey[] } {
  const { publicKey, kid } = signingKey();
  const jwk = publicKey.export({ format: 'jwk' });
  let previous: crypto.JsonWebKey[] = [];
  if (process.env.EXTENSION_SIGNING_PREVIOUS_PUBLIC_JWKS) {
    try {
      const parsed = JSON.parse(process.env.EXTENSION_SIGNING_PREVIOUS_PUBLIC_JWKS) as { keys?: crypto.JsonWebKey[] };
      previous = Array.isArray(parsed.keys)
        ? parsed.keys.filter((key) => key.kty === 'EC' && key.crv === 'P-256' && typeof key.kid === 'string')
        : [];
    } catch {
      throw new ExtensionAuthError('EXTENSION_SIGNING_PREVIOUS_PUBLIC_JWKS is invalid', 500);
    }
  }
  return { keys: [{ ...jwk, kid, use: 'sig', alg: 'ES256' }, ...previous.filter((key) => key.kid !== kid)] };
}

export function extensionIssuerDiscovery(): Record<string, unknown> {
  const issuer = extensionIssuer();
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    token_endpoint: `${issuer}/api/extensions/token`,
    public_extension_token_endpoint: `${issuer}/api/extensions/public-token/{orgId}/{siteId}/{installationId}`,
    provider_api_transport: 'direct',
    protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
    signing_algorithms_supported: ['ES256'],
  };
}

export interface DelegatedExtensionClaims {
  iss: string;
  aud: string;
  sub: string;
  org_id: string;
  site_id: string;
  installation_id: string;
  permission: SharePermission;
  scopes: ExtensionScope[];
  jti: string;
  iat: number;
  exp: number;
}

export interface PublicExtensionClaims {
  iss: string;
  aud: string;
  sub: string;
  token_use: 'public_extension';
  org_id: string;
  site_id: string;
  installation_id: string;
  origin: string;
  /** Present only on isolated previews. Providers must enforce preview_routes. */
  preview?: true;
  preview_routes?: ExtensionApiRoute[];
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Browser-safe proof that a public Extension is currently installed.
 * This is identity, not a proxy and not authority over provider-owned data.
 */
export function signPublicExtensionToken(args: {
  installation: ExtensionInstallation;
  origin: string;
  previewRoutes?: ExtensionApiRoute[];
  now?: Date;
}): { token: string; claims: PublicExtensionClaims } {
  const { privateKey, kid } = signingKey();
  const issuedAt = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const claims: PublicExtensionClaims = {
    iss: extensionIssuer(),
    aud: args.installation.extension_id,
    sub: args.installation.id,
    token_use: 'public_extension',
    org_id: args.installation.owner_org_id,
    site_id: args.installation.site_id,
    installation_id: args.installation.id,
    origin: args.origin,
    ...(args.previewRoutes ? { preview: true as const, preview_routes: args.previewRoutes } : {}),
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + PUBLIC_EXTENSION_TOKEN_TTL_SECONDS,
  };
  const header = b64Json({ alg: 'ES256', typ: 'JWT', kid });
  const payload = b64Json(claims);
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { token: `${header}.${payload}.${signature}`, claims };
}

export function verifyPublicExtensionToken(
  token: string,
  expectedAudience: string,
  now = new Date(),
): PublicExtensionClaims {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) throw new ExtensionAuthError('Invalid token', 401);
  let header: { alg?: string; kid?: string };
  let claims: PublicExtensionClaims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new ExtensionAuthError('Invalid token', 401);
  }
  const { publicKey, kid } = signingKey();
  const valid = header.alg === 'ES256' && header.kid === kid && crypto.verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(encodedSignature, 'base64url'),
  );
  const epoch = Math.floor(now.getTime() / 1000);
  if (!valid || claims.iss !== extensionIssuer() || claims.aud !== expectedAudience ||
    claims.token_use !== 'public_extension' || claims.exp <= epoch || claims.iat > epoch + 30) {
    throw new ExtensionAuthError('Invalid or expired token', 401);
  }
  return claims;
}

export function signDelegatedExtensionToken(
  claims: Omit<DelegatedExtensionClaims, 'iss' | 'iat' | 'exp' | 'jti'>,
  now = new Date(),
): { token: string; claims: DelegatedExtensionClaims } {
  const { privateKey, kid } = signingKey();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const complete: DelegatedExtensionClaims = {
    ...claims,
    iss: extensionIssuer(),
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + USER_TOKEN_TTL_SECONDS,
  };
  const header = b64Json({ alg: 'ES256', typ: 'JWT', kid });
  const payload = b64Json(complete);
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { token: `${header}.${payload}.${signature}`, claims: complete };
}

export function verifyDelegatedExtensionToken(
  token: string,
  expectedAudience: string,
  now = new Date(),
): DelegatedExtensionClaims {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) throw new ExtensionAuthError('Invalid token', 401);
  let header: { alg?: string; kid?: string };
  let claims: DelegatedExtensionClaims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new ExtensionAuthError('Invalid token', 401);
  }
  const { publicKey, kid } = signingKey();
  if (header.alg !== 'ES256' || header.kid !== kid) throw new ExtensionAuthError('Invalid token', 401);
  const valid = crypto.verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), {
    key: publicKey,
    dsaEncoding: 'ieee-p1363',
  }, Buffer.from(encodedSignature, 'base64url'));
  const epoch = Math.floor(now.getTime() / 1000);
  if (!valid || claims.iss !== extensionIssuer() || claims.aud !== expectedAudience || claims.exp <= epoch || claims.iat > epoch + 30) {
    throw new ExtensionAuthError('Invalid or expired token', 401);
  }
  return claims;
}

export function signInstallationAssertion(args: {
  installation: ExtensionInstallation;
  scopes: ExtensionScope[];
  correlationId: string;
  now?: Date;
}): string {
  const { privateKey, kid } = signingKey();
  const issuedAt = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const header = b64Json({ alg: 'ES256', typ: 'JWT', kid });
  const payload = b64Json({
    iss: extensionIssuer(),
    aud: args.installation.extension_id,
    sub: args.installation.id,
    token_use: 'installation',
    org_id: args.installation.owner_org_id,
    site_id: args.installation.site_id,
    installation_id: args.installation.id,
    scopes: args.scopes,
    correlation_id: args.correlationId,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + 60,
  });
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export function signIssuerPairingAssertion(args: {
  installation: ExtensionInstallation;
  nonce: string;
  now?: Date;
}): string {
  const { privateKey, kid } = signingKey();
  const issuedAt = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const header = b64Json({ alg: 'ES256', typ: 'JWT', kid });
  const payload = b64Json({
    iss: extensionIssuer(),
    aud: args.installation.extension_id,
    sub: args.installation.id,
    token_use: 'issuer_pairing',
    org_id: args.installation.owner_org_id,
    site_id: args.installation.site_id,
    installation_id: args.installation.id,
    nonce: args.nonce,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + 5 * 60,
  });
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function encodeLaunchCode(parts: string[]): string {
  return Buffer.from(parts.join('~')).toString('base64url');
}

function decodeLaunchCode(code: string): { orgId: string; siteId: string; installationId: string; grantId: string; secret: string } | null {
  try {
    const parts = Buffer.from(code, 'base64url').toString('utf8').split('~');
    if (parts.length !== 5 || parts.some((part) => !part || part.includes('/'))) return null;
    const [orgId, siteId, installationId, grantId, secret] = parts;
    return { orgId: orgId!, siteId: siteId!, installationId: installationId!, grantId: grantId!, secret: secret! };
  } catch {
    return null;
  }
}

export async function issueExtensionLaunchGrant(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  userId: string;
  permission: SharePermission;
  minimumPermission: SharePermission;
  now?: Date;
}): Promise<{ code: string; expires_at: string }> {
  const ranks: Record<SharePermission, number> = { read: 0, write: 1, admin: 2 };
  if (ranks[args.permission] < ranks[args.minimumPermission]) throw new ExtensionAuthError('Insufficient permission', 403);
  const store = getStore();
  const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId));
  if (!installation || installation.status !== 'enabled') throw new ExtensionAuthError('Extension installation is unavailable', 404);
  const version = (await resolveExtensionVersion(installation)).version;
  if (!version) throw new ExtensionAuthError('No compatible Extension release is available', 409);
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LAUNCH_TTL_SECONDS * 1000).toISOString();
  const grantId = `grant_${generateDocId()}`;
  const secret = crypto.randomBytes(32).toString('base64url');
  const grant: Omit<ExtensionLaunchGrant, 'id'> = {
    code_hash: hash(secret),
    extension_id: installation.extension_id,
    installation_id: installation.id,
    owner_org_id: args.ownerOrgId,
    site_id: args.siteId,
    user_id: args.userId,
    permission: args.permission,
    scopes: effectiveExtensionScopes(installation.granted_scopes, args.permission),
    audience: installation.extension_id,
    issued_at: now.toISOString(),
    expires_at: expiresAt,
  };
  await store.setDoc(paths.extensionLaunchGrant(args.ownerOrgId, args.siteId, installation.id, grantId), grant);
  return { code: encodeLaunchCode([args.ownerOrgId, args.siteId, installation.id, grantId, secret]), expires_at: expiresAt };
}

export async function exchangeExtensionLaunchCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  now?: Date;
}): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number }> {
  const parsed = decodeLaunchCode(args.code);
  const reject = () => { throw new ExtensionAuthError('Invalid or expired launch code', 401); };
  if (!parsed) reject();
  const store = getStore();
  const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(parsed!.orgId, parsed!.siteId, parsed!.installationId));
  if (!installation || installation.status !== 'enabled') reject();
  const extension = await store.getDoc<Extension>(paths.extension(installation!.developer_org_id, installation!.extension_id));
  const suppliedHash = hash(args.clientSecret);
  if (!extension || extension.status !== 'active' || extension.client_id !== args.clientId || !extension.client_secret_hash || !safeEqualHex(suppliedHash, extension.client_secret_hash)) reject();
  const now = args.now ?? new Date();
  const grantPath = paths.extensionLaunchGrant(parsed!.orgId, parsed!.siteId, parsed!.installationId, parsed!.grantId);
  const grant = await store.compareAndUpdateDoc<ExtensionLaunchGrant>(grantPath, (current) =>
    !current.used_at &&
    current.installation_id === parsed!.installationId &&
    current.extension_id === installation!.extension_id &&
    Date.parse(current.expires_at) > now.getTime() &&
    safeEqualHex(hash(parsed!.secret), current.code_hash),
  { used_at: now.toISOString() });
  if (!grant) reject();
  const signed = signDelegatedExtensionToken({
    aud: grant!.audience,
    sub: grant!.user_id,
    org_id: grant!.owner_org_id,
    site_id: grant!.site_id,
    installation_id: grant!.installation_id,
    permission: grant!.permission,
    scopes: grant!.scopes,
  }, now);
  await recordExtensionAudit({
    ownerOrgId: grant!.owner_org_id,
    siteId: grant!.site_id,
    extensionId: grant!.extension_id,
    installationId: grant!.installation_id,
    action: 'extension.launch.exchanged',
    actorId: grant!.user_id,
  });
  return { access_token: signed.token, token_type: 'Bearer', expires_in: USER_TOKEN_TTL_SECONDS };
}

export async function rotateInstallationCredential(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  actorId: string;
  graceSeconds?: number;
  now?: Date;
}): Promise<{ credential: string; prefix: string }> {
  const store = getStore();
  const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId));
  if (!installation || installation.status === 'revoked') throw new ExtensionAuthError('Installation not found', 404);
  const now = args.now ?? new Date();
  const graceUntil = new Date(now.getTime() + Math.max(0, args.graceSeconds ?? 300) * 1000).toISOString();
  const existing = await store.listDocs<InstallationCredential>(paths.extensionCredentials(args.ownerOrgId, args.siteId, args.installationId));
  for (const item of existing.filter((credential) => !credential.revoked_at)) {
    await store.updateDoc(paths.extensionCredential(args.ownerOrgId, args.siteId, args.installationId, item.id), { grace_until: graceUntil });
  }
  const prefix = crypto.randomBytes(6).toString('base64url');
  const secret = crypto.randomBytes(SERVICE_CREDENTIAL_BYTES).toString('base64url');
  const plaintext = `tri_${prefix}_${secret}`;
  const credential: InstallationCredential = {
    id: `cred_${generateDocId()}`,
    installation_id: installation.id,
    prefix,
    secret_hash: hash(plaintext),
    scopes: installation.granted_scopes,
    created_at: now.toISOString(),
  };
  const { id: _id, ...body } = credential;
  await store.setDoc(paths.extensionCredential(args.ownerOrgId, args.siteId, installation.id, credential.id), body);
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId,
    siteId: args.siteId,
    extensionId: installation.extension_id,
    installationId: installation.id,
    action: 'extension.credential_rotated',
    actorId: args.actorId,
    metadata: { grace_seconds: args.graceSeconds ?? 300 },
  });
  await (await import('./events')).notifyExtensionLifecycle({ installation, eventType: 'extension.credential_rotated' });
  return { credential: plaintext, prefix };
}

export async function authenticateInstallationCredential(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  credential: string;
  now?: Date;
}): Promise<{ installation: ExtensionInstallation; scopes: ExtensionScope[] }> {
  const match = /^tri_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]+)$/.exec(args.credential);
  if (!match) throw new ExtensionAuthError('Invalid installation credential', 401);
  const store = getStore();
  const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId));
  if (!installation || installation.status !== 'enabled') throw new ExtensionAuthError('Invalid installation credential', 401);
  const credentials = await store.listDocs<InstallationCredential>(paths.extensionCredentials(args.ownerOrgId, args.siteId, args.installationId), {
    filters: [{ field: 'prefix', op: '==', value: match[1] }],
    limit: 1,
  });
  const credential = credentials[0];
  const now = args.now ?? new Date();
  if (!credential || credential.revoked_at || (credential.expires_at && Date.parse(credential.expires_at) <= now.getTime()) ||
    (credential.grace_until && Date.parse(credential.grace_until) <= now.getTime()) ||
    !safeEqualHex(hash(args.credential), credential.secret_hash)) {
    throw new ExtensionAuthError('Invalid installation credential', 401);
  }
  await store.updateDoc(paths.extensionCredential(args.ownerOrgId, args.siteId, args.installationId, credential.id), { last_used_at: now.toISOString() });
  return { installation, scopes: credential.scopes };
}
