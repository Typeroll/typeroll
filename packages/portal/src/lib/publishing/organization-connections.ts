// Organization publishing connections (GitHub and Cloudflare) — the parts the
// portal Publishing page and the public API share.
//
// Connecting through OAuth is a browser flow: it is bound to the signed-in
// person and to the browser that started it, so the API cannot run it. It can
// read the connection status, disconnect, hand back the portal URL where an
// organization owner or admin completes the connection, connect Cloudflare
// with a customer API token, and finish media storage once Cloudflare is
// connected.

import type { FullSession } from '../access';
import { transferServiceStatus } from '../media/transfer-service';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { connectCloudflare, connectCloudflareMedia, prepareCloudflareMedia } from './cloudflare-connection';
import { cloudflareSetup } from './cloudflare-config';
import { ConnectionError, connectionSummary, disconnect, getConnection, type Provider } from './connections';
import { githubSetup } from './github-config';
import { getHostingGroup, hostingGroupId } from './hosting-groups';
import { mediaMigrationStatus } from './media-migration';

export const PUBLISHING_SETTINGS_PATH = '/app/settings/publishing';

export function isPublishingProvider(value: unknown): value is Provider {
  return value === 'github' || value === 'cloudflare';
}

/** Absolute portal URL of a provider's card on the Publishing page. */
export function publishingConnectUrl(provider: Provider): string {
  const base = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  return `${base}${PUBLISHING_SETTINGS_PATH}#${provider}`;
}

/** Status that does not depend on who is asking. Never includes credentials. */
export async function organizationConnectionsStatus(orgId: string) {
  return {
    media_transfer: await transferServiceStatus(orgId),
    media_migration: await mediaMigrationStatus(orgId),
    github: connectionSummary(await getConnection(orgId, 'github')),
    cloudflare: connectionSummary(await getConnection(orgId, 'cloudflare')),
    cloudflare_setup: cloudflareSetup(),
    github_setup: githubSetup(),
    encryption_available: isSecretCryptoConfigured(),
  };
}

/** Disconnect a provider at the revision the caller read. */
export async function disconnectOrganizationProvider(orgId: string, provider: unknown, body: Record<string, unknown>) {
  if (!isPublishingProvider(provider)) throw new ConnectionError('Unknown publishing provider', 404);
  if (typeof body?.revision !== 'string') throw new ConnectionError('Connection revision is required');
  const groupId = hostingGroupId(body.hosting_group_id ?? 'default');
  await getHostingGroup(orgId, groupId);
  await disconnect(orgId, provider, body.revision, groupId);
  return { disconnected: true };
}

/**
 * The Cloudflare steps that need no browser, for the organization's default
 * connection (media, DNS and default hosting). Additional Hosting Groups are
 * connected through /api/v1/publishing/hosting-groups.
 *
 *   connect       — account_id, bucket, api_token, access_key_id,
 *                   secret_access_key and the current revision; verified
 *                   against Cloudflare before anything is saved.
 *   prepare_media — create or reuse the organization's private and public
 *                   R2 buckets on the connected account.
 *   save_media    — save and verify R2 access keys for those buckets; queues
 *                   media migration.
 */
export async function applyCloudflareConnectionAction(actor: FullSession, body: Record<string, unknown>) {
  if (body.hosting_group_id !== undefined && hostingGroupId(body.hosting_group_id) !== 'default') {
    throw new ConnectionError('Connect additional Hosting Groups through /api/v1/publishing/hosting-groups.', 400);
  }
  if (body.action === 'prepare_media') {
    if (typeof body.revision !== 'string') throw new ConnectionError('Connection revision is required');
    return prepareCloudflareMedia(actor, body.revision);
  }
  if (body.action === 'save_media') {
    await connectCloudflareMedia(actor, body);
    return { media_ready: true };
  }
  if (body.action === 'connect') {
    await connectCloudflare(actor, body);
    return { connected: true };
  }
  throw new ConnectionError('action must be connect, prepare_media or save_media. OAuth sign-in needs a browser: open connect_url from the connections status.', 400);
}
