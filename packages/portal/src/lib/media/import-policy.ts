import { connectionSummary, getConnection, ConnectionError } from '../publishing/connections';

export const IMPORT_STORAGE_SETTINGS = '/app/settings/publishing#media-title';
export const IMPORT_STORAGE_MESSAGE = 'Connect and verify your organization’s own storage in Publishing → Media storage before starting an import. An organization owner or admin can complete this setup.';

/** Imports never use shared draft storage, including before the first connection. */
export async function importStorageStatus(orgId: string) {
  const connection = await getConnection(orgId, 'cloudflare');
  const ready = connectionSummary(connection).media_ready;
  return { ready, code: ready ? null : 'import_storage_required',
    message: ready ? 'Your organization’s storage is ready for imports.' : IMPORT_STORAGE_MESSAGE,
    settings_url: IMPORT_STORAGE_SETTINGS };
}

export async function requireImportStorage(orgId: string): Promise<void> {
  if (!(await importStorageStatus(orgId)).ready) {
    throw new ConnectionError(IMPORT_STORAGE_MESSAGE, 409, 'import_storage_required');
  }
}
