import workerSource from './transfer-worker.mjs?raw';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getStore } from '../datastore';
import { ConnectionError, getConnection, openCredentials, sealCredentials } from '../publishing/connections';
import { cloudflareClient, type CloudflareStoredCredentials } from '../publishing/cloudflare-oauth';
import { ProviderError } from '../publishing/providers.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceHash = hash(workerSource);
const path = (org: string) => `organizations/${org}/publishing_private/media_transfer`;
interface Configuration { state: 'preparing' | 'ready' | 'error'; account_id: string; origin: string; name: string; url: string; source_hash: string; encrypted_credentials: string; lease: string | null; lease_until: number; error?: string | null; error_code?: string | null }
export interface TransferService { url: string; secret: string }
export async function transferServiceStatus(org: string) {
  const [config, connection] = await Promise.all([getStore().getDoc<Configuration>(path(org)), getConnection(org, 'cloudflare')]);
  if (!connection.media_ready || connection.status !== 'connected') return { state: 'storage_required', message: 'Connect R2 to copy and verify files in your Cloudflare account.' };
  if (!config || config.account_id !== connection.cloudflare?.account_id) return { state: 'automatic', message: 'Media transfers are set up automatically in your Cloudflare account when needed.' };
  if (config.state === 'error') return { state: 'error', code: config.error_code, message: config.error };
  return { state: config.state === 'ready' && config.source_hash === sourceHash ? 'ready' : 'automatic', message: 'Files are copied and verified in your Cloudflare account. No GitHub connection is needed.' };
}
export async function remoteTransfersEnabled(org: string) {
  const connection = await getConnection(org, 'cloudflare');
  return Boolean(connection.media_ready);
}
/** One environment-scoped utility in the customer's account, independently of the build provider. */
export async function customerTransferService(org: string, force = false): Promise<TransferService> {
  const connection = await getConnection(org, 'cloudflare');
  if (!connection.media_ready || connection.status !== 'connected' || !connection.cloudflare || !connection.encrypted_credentials) throw new ConnectionError('Check the organization’s Media storage connection in Publishing.', 409, 'media_storage_unavailable');
  const origin = new URL(process.env.PORTAL_PUBLIC_URL ?? '').origin;
  if (!origin.startsWith('https://')) throw new ConnectionError('Media transfers require the public HTTPS address of this Typeroll server.', 503);
  const scope = hash(`${origin}\0${org}`).slice(0, 16), name = `typeroll-media-${scope}`, tag = `typeroll-media-${scope}`;
  const store = getStore(), deadline = Date.now() + 120000;
  const unlock = (config: Configuration) => {
    const saved = openCredentials<{ origin: string; account_id: string; secret: string }>(org, 'cloudflare', config.encrypted_credentials);
    if (saved.origin !== origin || saved.account_id !== connection.cloudflare!.account_id || !saved.secret) throw new ConnectionError('Media transfer identity changed.', 409);
    return { url: config.url, secret: saved.secret };
  };
  for (;;) {
    const current = await store.getDoc<Configuration>(path(org));
    if (!force && current?.state === 'ready' && current.source_hash === sourceHash && current.account_id === connection.cloudflare.account_id && current.origin === origin) return unlock(current);
    if ((current?.lease_until ?? 0) > Date.now()) {
      if (Date.now() > deadline) throw new ConnectionError('Media transfer setup is still running. Retry shortly.', 503, 'media_transfer_setup_pending');
      await new Promise(resolve => setTimeout(resolve, 500)); continue;
    }
    const lease = randomUUID();
    const secret = current?.account_id === connection.cloudflare.account_id && current.origin === origin ? unlock(current).secret : randomBytes(32).toString('base64url');
    const config: Configuration = { state: 'preparing', account_id: connection.cloudflare.account_id, origin, name, url: '', source_hash: sourceHash,
      encrypted_credentials: sealCredentials(org, 'cloudflare', { origin, account_id: connection.cloudflare.account_id, secret }), lease, lease_until: Date.now() + 120000, error: null, error_code: null };
    const claimed = current ? await store.compareAndUpdateDoc<Configuration>(path(org), value => value.lease_until <= Date.now(), config) : await store.createDocIfMissing(path(org), config);
    if (!claimed) continue;
    try {
      const credentials = openCredentials<CloudflareStoredCredentials>(org, 'cloudflare', connection.encrypted_credentials);
      if (credentials.oauth && !['workers-scripts.read', 'workers-scripts.write'].every(scope => credentials.oauth!.scope.split(/\s+/).includes(scope))) throw new ConnectionError('Allow media transfers in Publishing → Media storage. Cloudflare needs permission to create the transfer worker; your R2 keys do not need to be replaced.', 409, 'media_transfer_approval_required');
      const client = await cloudflareClient(org), base = `/accounts/${connection.cloudflare.account_id}`;
      // Expire abandoned copy staging objects without changing existing retention rules.
      const lifecyclePath = `${base}/r2/buckets/${connection.cloudflare.bucket}/lifecycle`;
      const lifecycle = await client(lifecyclePath, { missing: true });
      const expiry = { id: 'typeroll-expired-media-transfers', enabled: true, conditions: { prefix: 'transfer-staging/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } };
      await client(lifecyclePath, { method: 'PUT', body: { rules: [...(lifecycle?.rules ?? []).filter((rule: { id: string }) => rule.id !== expiry.id), expiry] } });
      const existing = await client(`${base}/workers/scripts/${name}/settings`, { missing: true });
      if (existing && !existing.tags?.includes(tag)) throw new ConnectionError('Another Worker uses the media transfer name. Typeroll has not changed it.', 409, 'media_transfer_name_conflict');
      const body = new FormData();
      body.append('metadata', JSON.stringify({ main_module: 'transfer.mjs', compatibility_date: '2026-09-14', tags: [tag],
        bindings: [{ type: 'secret_text', name: 'TRANSFER_SECRET', text: secret }, { type: 'plain_text', name: 'WORKER_SHA', text: sourceHash }], observability: { enabled: false } }));
      body.append('transfer.mjs', new Blob([workerSource], { type: 'application/javascript+module' }), 'transfer.mjs');
      await client(`${base}/workers/scripts/${name}`, { method: 'PUT', body });
      let subdomain = await client(`${base}/workers/subdomain`, { missing: true });
      if (!subdomain?.subdomain) subdomain = await client(`${base}/workers/subdomain`, { method: 'PUT', body: { subdomain: `typeroll-${hash(connection.cloudflare.account_id).slice(0, 16)}` } });
      if (!/^[a-z0-9-]+$/.test(subdomain?.subdomain ?? '')) throw new ConnectionError('Cloudflare did not provide a transfer address.', 503, 'media_transfer_setup_pending');
      await client(`${base}/workers/scripts/${name}/subdomain`, { method: 'POST', body: { enabled: true, previews_enabled: false } });
      const url = `https://${name}.${subdomain.subdomain}.workers.dev/transfer`;
      let healthy = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        const health = JSON.stringify({ protocol: 1, id: randomUUID(), expires_at: Date.now() + 90000 });
        try {
          const response = await fetch(url.replace('/transfer', '/health'), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'x-typeroll-signature': createHmac('sha256', secret).update(health).digest('hex') }, body: health });
          const text = await response.text(), supplied = response.headers.get('x-typeroll-signature');
          healthy = response.ok && text.length < 1024 && /^[a-f0-9]{64}$/.test(supplied ?? '') && timingSafeEqual(Buffer.from(supplied!, 'hex'), createHmac('sha256', secret).update(text).digest()) && JSON.parse(text).worker_sha === sourceHash && JSON.parse(text).id === JSON.parse(health).id;
          if (healthy) break;
        } catch { /* A newly deployed workers.dev hostname may still be propagating. */ }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (!healthy) throw new ConnectionError('Cloudflare is activating the media transfer service. Retry shortly; your original files are unchanged.', 503, 'media_transfer_setup_pending');
      const latest = await getConnection(org, 'cloudflare');
      if (latest.status !== 'connected' || !latest.media_ready || latest.cloudflare?.account_id !== config.account_id || latest.cloudflare?.bucket !== connection.cloudflare.bucket) throw new ConnectionError('Media storage changed during setup. Reload Publishing.', 409, 'media_revision_conflict');
      if (!await store.compareAndUpdateDoc<Configuration>(path(org), value => value.lease === lease, { state: 'ready', url, lease: null, lease_until: 0 })) throw new ConnectionError('Media transfer setup changed. Retry shortly.', 409);
      return { url, secret };
    } catch (error) {
      const issue = error instanceof ConnectionError ? error : new ConnectionError(error instanceof ProviderError && error.status === 403 ? 'Cloudflare denied media transfer setup. Allow media transfers in Publishing → Media storage.' : 'Cloudflare could not prepare media transfers. Retry from Publishing → Media storage.', 503, error instanceof ProviderError && error.status === 403 ? 'media_transfer_approval_required' : 'media_transfer_setup_failed');
      await store.compareAndUpdateDoc<Configuration>(path(org), value => value.lease === lease, { state: 'error', lease: null, lease_until: 0, error: issue.message, error_code: issue.code ?? 'media_transfer_setup_failed' });
      throw issue;
    }
  }
}
