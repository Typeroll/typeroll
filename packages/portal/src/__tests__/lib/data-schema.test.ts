import { afterEach, describe, expect, it } from 'vitest';
import { DATA_SCHEMA_VERSION } from '@typeroll/shared';
import { INSTALLATION_PATH, requireCurrentDataSchema, validateInstalledDataSchema } from '../../lib/data-schema';
import { setRuntimeStore, type ReadWriteStore } from '../../lib/datastore';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { SqlStore, localTransport } from '../../lib/store/sql-store';

let ids = 0;
function runtimeStore(): ReadWriteStore {
  const store = new SqlStore(localTransport(new SqlDocumentEngine(nodeSqliteDriver())), () => `id${++ids}`);
  setRuntimeStore(() => store);
  return store;
}

afterEach(() => setRuntimeStore(null));

it('refuses missing, old and future schemas, including an expired migration lock', () => {
  for (const value of [null, {}, { data_schema_version: 1 }, { data_schema_version: 3 }]) {
    expect(() => validateInstalledDataSchema(value)).toThrow('must be migrated');
  }
  expect(() => validateInstalledDataSchema({ data_schema_version: 2, migration_lock: { expires_at: '2000-01-01' } })).toThrow('in progress');
  expect(() => validateInstalledDataSchema({ data_schema_version: 2 })).not.toThrow();
});

describe('installation record on the Durable Object store', () => {
  it('does not gate fixtures or a local SQLite file', async () => {
    await expect(requireCurrentDataSchema({})).resolves.toBeUndefined();
    await expect(requireCurrentDataSchema({ TYPEROLL_STORE: 'sqlite:/tmp/none.sqlite' })).resolves.toBeUndefined();
  });

  it('refuses a store without its record unless bootstrapping is allowed', async () => {
    const store = runtimeStore();
    await expect(requireCurrentDataSchema({})).rejects.toThrow('must be migrated');
    expect(await store.getDoc(INSTALLATION_PATH)).toBeNull();
  });

  it('records the current schema in an empty store that may bootstrap, deterministically', async () => {
    const store = runtimeStore();
    await requireCurrentDataSchema({ TYPEROLL_STORE_BOOTSTRAP: 'empty' });
    expect(await store.getDoc(INSTALLATION_PATH)).toEqual({ id: 'installation', data_schema_version: DATA_SCHEMA_VERSION });
  });

  it('lets local workerd bootstrap', async () => {
    const store = runtimeStore();
    await requireCurrentDataSchema({ STORE_JURISDICTION: 'none' });
    expect(await store.getDoc(INSTALLATION_PATH)).toMatchObject({ data_schema_version: DATA_SCHEMA_VERSION });
  });

  it('never adopts existing data that has no record', async () => {
    const store = runtimeStore();
    await store.setDoc('organizations/org-1', { name: 'Existing' });
    await expect(requireCurrentDataSchema({ TYPEROLL_STORE_BOOTSTRAP: 'empty' })).rejects.toThrow('must be migrated');
    expect(await store.getDoc(INSTALLATION_PATH)).toBeNull();
  });

  it('refuses an imported record of another schema and a running migration', async () => {
    const store = runtimeStore();
    await store.setDoc(INSTALLATION_PATH, { data_schema_version: DATA_SCHEMA_VERSION - 1 });
    await expect(requireCurrentDataSchema({ TYPEROLL_STORE_BOOTSTRAP: 'empty' })).rejects.toThrow('must be migrated');
    await store.setDoc(INSTALLATION_PATH, { data_schema_version: DATA_SCHEMA_VERSION, migration_lock: { by: 'upgrade' } });
    await expect(requireCurrentDataSchema({})).rejects.toThrow('in progress');
  });

  it('trusts a verified record briefly instead of reading it on every request', async () => {
    const store = runtimeStore();
    await store.setDoc(INSTALLATION_PATH, { data_schema_version: DATA_SCHEMA_VERSION });
    let now = 1_000;
    await requireCurrentDataSchema({}, () => now);
    await store.setDoc(INSTALLATION_PATH, { data_schema_version: DATA_SCHEMA_VERSION, migration_lock: { by: 'upgrade' } });
    now += 1_000;
    await expect(requireCurrentDataSchema({}, () => now)).resolves.toBeUndefined();
    now += 30_000;
    await expect(requireCurrentDataSchema({}, () => now)).rejects.toThrow('in progress');
  });
});
