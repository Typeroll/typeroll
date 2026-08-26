import crypto from 'node:crypto';
import {
  paths,
  type ExtensionInstallation,
  type ExtensionVersion,
  type TrustedExtensionIssuer,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { extensionIssuer, extensionJwks, signIssuerPairingAssertion } from './auth';
import { assertPublicDestination, parsePublicHttpsUrl } from './public-http';
import { ExtensionRegistryError, recordExtensionAudit } from './registry';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function trustedExtensionIssuerId(issuer: string): string {
  return `issuer_${hash(issuer).slice(0, 24)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function pairExtensionIssuer(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  actorId: string;
  fetchImpl?: typeof fetch;
}): Promise<TrustedExtensionIssuer> {
  const store = getStore();
  const installation = await store.getDoc<ExtensionInstallation>(
    paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId),
  );
  if (!installation || installation.status === 'revoked') throw new ExtensionRegistryError('Installation not found', 404);
  const version = await store.getDoc<ExtensionVersion>(
    paths.extensionVersion(installation.developer_org_id, installation.extension_id, installation.version),
  );
  const pairingUrlRaw = version?.manifest.auth?.pairing_url;
  if (!pairingUrlRaw) throw new ExtensionRegistryError('Extension does not declare an issuer pairing endpoint', 409);
  const pairingUrl = parsePublicHttpsUrl(pairingUrlRaw, 'Extension pairing URL');
  await assertPublicDestination(pairingUrl);

  const issuer = extensionIssuer();
  const jwks = extensionJwks();
  const jwksFingerprint = hash(canonicalJson(jwks));
  const nonce = crypto.randomBytes(32).toString('base64url');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await (args.fetchImpl ?? fetch)(pairingUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Typeroll-Extension-Pairing/1.0' },
      body: JSON.stringify({
        protocol_version: 1,
        issuer,
        discovery_url: `${issuer}/.well-known/typeroll-extension-issuer`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        jwks_fingerprint: jwksFingerprint,
        installation_id: installation.id,
        nonce,
        assertion: signIssuerPairingAssertion({ installation, nonce }),
      }),
    });
  } catch {
    throw new ExtensionRegistryError('Extension provider pairing endpoint is unavailable', 502);
  } finally {
    clearTimeout(timeout);
  }
  if (response.status >= 300 && response.status < 400) throw new ExtensionRegistryError('Pairing redirects are not allowed', 502);
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || body?.trusted !== true || body.issuer !== issuer || body.nonce !== nonce || body.jwks_fingerprint !== jwksFingerprint) {
    throw new ExtensionRegistryError('Extension provider did not confirm the issuer fingerprint and nonce', 502);
  }
  const now = new Date().toISOString();
  const issuerId = trustedExtensionIssuerId(issuer);
  const trusted: TrustedExtensionIssuer = {
    id: issuerId,
    extension_id: installation.extension_id,
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    jwks_fingerprint: jwksFingerprint,
    status: 'trusted',
    nonce_hash: hash(nonce),
    paired_at: now,
    created_at: now,
  };
  const { id: _id, ...record } = trusted;
  await store.setDoc(paths.trustedExtensionIssuer(installation.developer_org_id, installation.extension_id, issuerId), record);
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId,
    siteId: args.siteId,
    installationId: installation.id,
    extensionId: installation.extension_id,
    actorId: args.actorId,
    action: 'extension.issuer_paired',
    metadata: { issuer, jwks_fingerprint: jwksFingerprint },
  });
  return trusted;
}
