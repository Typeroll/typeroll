// The self-host backup/restore endpoint: token gate, object listing, paging
// and batch reads over a sharded store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShardedStore } from '../../lib/store/sharded-store';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { localTransport } from '../../lib/store/sql-store';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { handleStoreTransfer, setStoreTransferRuntime, storeTransferAuthorized } from '../../lib/runtime/store-transfer';
import { POST } from '../../pages/api/internal/store-transfer';

const TOKEN = 'store-transfer-token-0123456789abcdef-0123';
let engines: Map<string, SqlDocumentEngine>;

beforeEach(async () => {
  engines = new Map();
  const engine = (name: string) => { if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver())); return engines.get(name)!; };
  const store = new ShardedStore({ transport: name => localTransport(engine(name)) }, () => 'id');
  setStoreTransferRuntime(() => ({ store, object: name => engine(name), migration: null }));
  await store.setDoc('organizations/acme', { name: 'Acme' });
  await store.setDoc('organizations/acme/sites/www', { name: 'WWW' });
  await store.setDoc('organizations/acme/sites/www/pages/home', { title: 'Home' });
  await store.setDoc('organizations/acme/sites/www/pages/about', { title: 'About' });
  process.env.TYPEROLL_STORE_TRANSFER_TOKEN = TOKEN;
});
afterEach(() => { setStoreTransferRuntime(null); delete process.env.TYPEROLL_STORE_TRANSFER_TOKEN; });

describe('store transfer', () => {
  it('answers 404 without the exact token, and when no token is configured', async () => {
    const call = (authorization?: string) => POST({ request: new Request('https://portal.test/api/internal/store-transfer', {
      method: 'POST', headers: authorization ? { authorization } : {}, body: JSON.stringify({ action: 'objects' }),
    }) } as never) as Promise<Response>;
    expect((await call()).status).toBe(404);
    expect((await call(`Bearer ${TOKEN}x`)).status).toBe(404);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(200);
    delete process.env.TYPEROLL_STORE_TRANSFER_TOKEN;
    expect(storeTransferAuthorized(`Bearer ${TOKEN}`)).toBe(false);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(404);
  });

  it('lists every object and pages through its documents', async () => {
    const { objects } = await handleStoreTransfer({ action: 'objects' }) as { objects: Array<{ name: string; kind: string }> };
    const site = objects.find(object => object.kind === 'site')!;
    expect(objects.map(object => object.kind)).toEqual(['global', 'org', 'site']);
    const first = await handleStoreTransfer({ action: 'paths', object: site.name, after: '', limit: 2 }) as { paths: string[]; next: string | null };
    const second = await handleStoreTransfer({ action: 'paths', object: site.name, after: first.next, limit: 2 }) as { paths: string[]; next: string | null };
    expect([...first.paths, ...second.paths]).toEqual(['organizations/acme/sites/www', 'organizations/acme/sites/www/pages/about', 'organizations/acme/sites/www/pages/home']);
    const { documents } = await handleStoreTransfer({ action: 'get_many', object: site.name, paths: ['organizations/acme/sites/www/pages/home', 'missing/doc'] }) as { documents: Array<{ data: unknown } | null> };
    expect(documents).toEqual([{ data: { title: 'Home' } }, null]);
  });

  it('refuses unknown objects, actions and a missing migration bucket', async () => {
    await expect(handleStoreTransfer({ action: 'paths', object: '../global' })).rejects.toThrow(/Invalid object/);
    await expect(handleStoreTransfer({ action: 'drop' })).rejects.toThrow(/Unknown action/);
    await expect(handleStoreTransfer({ action: 'migration', run: 'r1', step: 'import' })).rejects.toThrow(/MIGRATION/);
  });
});
