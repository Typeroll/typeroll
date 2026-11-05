import { DATA_SCHEMA_VERSION } from '@typeroll/shared';
import { getStore, storeBackend, type ReadWriteStore } from './datastore';

/**
 * The installation record: the data schema the stored documents follow. It is
 * a root document, so the Durable Object store keeps it in the global object,
 * and the store migration carries it over from Firestore unchanged.
 */
export const INSTALLATION_PATH = 'typeroll_system/installation';

/** A verified current schema is trusted for this long per isolate, so requests do not all read the global object. */
const VERIFIED_FOR_MS = 30_000;

export function validateInstalledDataSchema(installation: Record<string, unknown> | null): void {
  if (!installation || installation.data_schema_version !== DATA_SCHEMA_VERSION) {
    throw new Error('The database must be migrated before this Core version can serve it.');
  }
  if (installation.migration_lock) throw new Error('Database migration is in progress.');
}

/**
 * Whether an empty store may record the current schema itself. A new
 * self-hosted installation sets TYPEROLL_STORE_BOOTSTRAP=empty; local workerd
 * (STORE_JURISDICTION=none) always may. Typeroll Cloud never sets it: its
 * objects receive the installation record from the store migration, and a
 * record written first would conflict with the imported one.
 */
export function mayBootstrapEmptyStore(env: Record<string, string | undefined> = process.env): boolean {
  return env.TYPEROLL_STORE_BOOTSTRAP?.trim() === 'empty' || env.STORE_JURISDICTION?.trim() === 'none';
}

let verified: { store: ReadWriteStore; until: number } | null = null;

/**
 * Never let the runtime partially read another schema. Fixtures and a local
 * SQLite file are versioned with the source; the deployed Durable Object store
 * requires its installation record. An empty store gets one only when
 * bootstrapping is allowed, and only while it holds no organization, so data
 * without a record is never adopted silently.
 */
export async function requireCurrentDataSchema(
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): Promise<void> {
  if (storeBackend(env) !== 'durable_object') return;
  const store = getStore();
  if (verified?.store === store && verified.until > now()) return;
  let installation = await store.getDoc<Record<string, unknown>>(INSTALLATION_PATH);
  if (!installation && mayBootstrapEmptyStore(env)
    && (await store.listDocs('organizations', { limit: 1 })).length === 0) {
    // Deterministic content: a backup of this installation restores the same
    // record, so a restore into a freshly bootstrapped store does not conflict.
    await store.createDocIfMissing(INSTALLATION_PATH, { data_schema_version: DATA_SCHEMA_VERSION });
    installation = await store.getDoc<Record<string, unknown>>(INSTALLATION_PATH);
  }
  validateInstalledDataSchema(installation);
  verified = { store, until: now() + VERIFIED_FOR_MS };
}
