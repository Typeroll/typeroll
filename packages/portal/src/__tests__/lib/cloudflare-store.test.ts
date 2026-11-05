// The Cloudflare store wiring: EU jurisdiction for every stub, and a fresh stub
// per call (stubs are bound to the request that created them).
import { describe, expect, it, vi } from 'vitest';
import { cloudflareStore, storeObject, type StoreEnv } from '../../lib/runtime/cloudflare-store';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';

function fakeEnv(jurisdiction?: string) {
  const engines = new Map<string, SqlDocumentEngine>();
  const stubs: string[] = [];
  const namespace = {
    jurisdictions: [] as string[],
    jurisdiction: vi.fn((name: 'eu') => { namespace.jurisdictions.push(name); return namespace; }),
    idFromName: (name: string) => name,
    get: (name: string) => {
      stubs.push(name);
      if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver()));
      return engines.get(name)!;
    },
  };
  return { env: { STORE: namespace, ...(jurisdiction ? { STORE_JURISDICTION: jurisdiction } : {}) } as unknown as StoreEnv, namespace, stubs };
}

describe('Cloudflare store', () => {
  it('creates every stub in the EU jurisdiction unless local development opts out', () => {
    const eu = fakeEnv();
    storeObject(eu.env, 'global');
    expect(eu.namespace.jurisdictions).toEqual(['eu']);
    const local = fakeEnv('none');
    storeObject(local.env, 'global');
    expect(local.namespace.jurisdictions).toEqual([]);
  });

  it('resolves a fresh stub for every call', async () => {
    const { env, stubs } = fakeEnv();
    const store = cloudflareStore(env);
    await store.setDoc('things/a', { n: 1 });
    const before = stubs.length;
    expect(await store.getDoc('things/a')).toMatchObject({ n: 1 });
    expect(await store.getDoc('things/a')).toMatchObject({ n: 1 });
    expect(stubs.length).toBeGreaterThanOrEqual(before + 2);
  });
});
