import {
  EXTENSION_MANIFEST_SCHEMA_VERSION,
  paths,
  type ExtensionInstallation,
  type ExtensionVersion,
  type Site,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { clientIp, rateLimit } from '../rate-limit';
import { signPublicExtensionToken } from './auth';

export class PublicExtensionTokenError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'PublicExtensionTokenError';
  }
}

function siteOrigins(site: Site, siteId: string): Set<string> {
  const origins = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (url.protocol === 'https:' && !url.username && !url.password) origins.add(url.origin);
    } catch {
      // Invalid stored URLs are ignored and therefore fail closed.
    }
  };
  add(site.domain);
  add(site.hosting_config?.fallback_subdomain);
  add(site.staging_url);
  const baseDomain = (process.env.SITES_BASE_DOMAIN ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (baseDomain) add(`${site.slug ?? siteId}.${baseDomain}`);
  return origins;
}

export async function publicExtensionCors(args: {
  request: Request;
  orgId: string;
  siteId: string;
}): Promise<Record<string, string>> {
  const origin = args.request.headers.get('origin');
  if (!origin) throw new PublicExtensionTokenError('Origin is required', 403);
  const site = await getStore().getDoc<Site>(paths.site(args.orgId, args.siteId));
  if (!site || !siteOrigins(site, args.siteId).has(origin)) throw new PublicExtensionTokenError('Origin is not allowed', 403);
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

export async function issuePublicExtensionToken(args: {
  request: Request;
  orgId: string;
  siteId: string;
  installationId: string;
}): Promise<{ token: string; expires_in: number; cors: Record<string, string> }> {
  const cors = await publicExtensionCors(args);
  const limit = rateLimit(
    `extension-public-token:${args.siteId}:${args.installationId}:${clientIp(args.request.headers)}`,
    60,
    60_000,
  );
  if (!limit.allowed) throw new PublicExtensionTokenError('Rate limit exceeded', 429);
  const store = getStore();
  const installation = await store.getDoc<ExtensionInstallation>(
    paths.extensionInstallation(args.orgId, args.siteId, args.installationId),
  );
  if (!installation || installation.status !== 'enabled' ||
    installation.owner_org_id !== args.orgId || installation.site_id !== args.siteId) {
    throw new PublicExtensionTokenError('Extension installation is unavailable', 404);
  }
  const version = await store.getDoc<ExtensionVersion>(
    paths.extensionVersion(installation.developer_org_id, installation.extension_id, installation.version),
  );
  if (!version || version.status === 'revoked' ||
    version.schema_version !== EXTENSION_MANIFEST_SCHEMA_VERSION ||
    version.manifest.schema_version !== EXTENSION_MANIFEST_SCHEMA_VERSION ||
    !version.manifest.api ||
    (version.manifest.api.authentication ?? 'signed_installation') !== 'signed_installation') {
    throw new PublicExtensionTokenError('Signed Extension API is unavailable', 404);
  }
  const origin = args.request.headers.get('origin')!;
  return {
    token: signPublicExtensionToken({ installation, origin }).token,
    expires_in: 5 * 60,
    cors,
  };
}
