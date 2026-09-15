import { DATA_SCHEMA_VERSION } from '@typeroll/shared';
import { getStore } from './datastore';
import { isFirebaseAdminConfigured } from './firebase-admin';

export function validateInstalledDataSchema(installation: Record<string, unknown> | null): void {
  if (!installation || installation.data_schema_version !== DATA_SCHEMA_VERSION) {
    throw new Error('The database must be migrated before this Core version can serve it.');
  }
  if (installation.migration_lock) throw new Error('Database migration is in progress.');
}

/** Never let the new runtime partially read schema 1. Fixtures are versioned
 * with the source; deployed Firebase installations require explicit metadata. */
export async function requireCurrentDataSchema(): Promise<void> {
  if (!isFirebaseAdminConfigured()) return;
  const installation = await getStore().getDoc('typeroll_system/installation');
  validateInstalledDataSchema(installation);
}
