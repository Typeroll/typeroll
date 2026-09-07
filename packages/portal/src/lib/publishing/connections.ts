import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { decryptSecret, encryptSecret } from '../secret-crypto';

export class ConnectionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type Provider = 'github' | 'cloudflare';
export interface Connection {
  revision: string;
  status: 'connected' | 'disconnected';
  connected_at?: string;
  connected_by?: string;
  github?: { app_id: string; installation_id: string; account_id: string; owner: string };
  cloudflare?: { account_id: string; account_name: string; bucket: string; endpoint: string; public_base_url?: string };
  encrypted_credentials?: string | null;
  auth_method?: 'api_token' | 'oauth';
  media_ready?: boolean;
  refresh_lease?: { id: string; expires_at: number } | null;
}

function segment(value: string): string {
  if (!value || /[/\\\x00-\x1f]/.test(value) || value === '.' || value === '..') throw new ConnectionError('Invalid connection identity');
  return value;
}

export function connectionPath(orgId: string, provider: Provider): string {
  return `organizations/${segment(orgId)}/publishing_connections/${provider}`;
}

export async function getConnection(orgId: string, provider: Provider): Promise<Connection> {
  const path = connectionPath(orgId, provider);
  await getStore().createDocIfMissing(path, { status: 'disconnected', revision: randomUUID() });
  return (await getStore().getDoc<Connection>(path))!;
}

/** Only this projection may leave the server. Never serialize a stored record. */
export function connectionSummary(connection: Connection) {
  return {
    status: connection.status, revision: connection.revision,
    connected_at: connection.connected_at ?? null,
    github: connection.github ? {
      app_id: connection.github.app_id, installation_id: connection.github.installation_id,
      account_id: connection.github.account_id, owner: connection.github.owner,
    } : null,
    cloudflare: connection.cloudflare ? {
      account_id: connection.cloudflare.account_id, account_name: connection.cloudflare.account_name,
      bucket: connection.cloudflare.bucket, endpoint: connection.cloudflare.endpoint,
      public_base_url: connection.cloudflare.public_base_url ?? null,
    } : null,
    credentials_saved: connection.status === 'connected' && Boolean(connection.encrypted_credentials),
    auth_method: connection.auth_method ?? 'api_token',
    media_ready: connection.status === 'connected' && (connection.media_ready ?? Boolean(connection.cloudflare?.bucket)),
  };
}

export function sealCredentials(orgId: string, provider: Provider, credentials: unknown): string {
  return encryptSecret(JSON.stringify({ org_id: orgId, provider, credentials }));
}

export function openCredentials<T>(orgId: string, provider: Provider, encrypted: string): T {
  try {
    const payload = JSON.parse(decryptSecret(encrypted));
    if (payload.org_id !== orgId || payload.provider !== provider) throw new Error();
    return payload.credentials as T;
  } catch { throw new ConnectionError('Stored publishing credentials could not be opened', 503); }
}

/** Claims survive disconnects: moving an account between tenants is an explicit transfer. */
export async function claimAccount(orgId: string, provider: Provider, accountId: string): Promise<void> {
  const path = `publishing_account_claims/${provider}-${segment(accountId)}`;
  await getStore().createDocIfMissing(path, { org_id: orgId });
  const claim = await getStore().getDoc<{ org_id: string }>(path);
  if (claim?.org_id !== orgId) throw new ConnectionError('This account is already connected to another Typeroll organization', 409);
}

export async function saveConnection(orgId: string, provider: Provider, revision: string, data: Partial<Connection>): Promise<void> {
  const changed = await getStore().compareAndUpdateDoc<Connection>(connectionPath(orgId, provider),
    // Metadata/media updates must not invalidate an in-flight rotating grant.
    // Disconnect and a fresh authorization explicitly replace that grant.
    (current) => current.revision === revision && (!current.refresh_lease || data.refresh_lease === null),
    { ...data, revision: randomUUID() });
  if (!changed) throw new ConnectionError('The connection changed. Reload the page and try again.', 409);
}

export async function disconnect(orgId: string, provider: Provider, revision: string): Promise<void> {
  await saveConnection(orgId, provider, revision, { status: 'disconnected', encrypted_credentials: null, refresh_lease: null });
}
