export const SELF_HOST_INSTALLATION_PATH = 'typeroll_system/installation';
export const SELF_HOST_BACKUP_FORMAT_VERSION = 1;
export const SELF_HOST_CORE_VERSION = '0.2.31';
export const SELF_HOST_DATA_SCHEMA_VERSION = 2;
export const SELF_HOST_DATA_SCHEMA_READABLE_MIN = 2;
export const SELF_HOST_DATA_SCHEMA_READABLE_MAX = 2;

/**
 * Ordered, idempotent data migrations. Each future entry advances exactly one
 * schema version and must tolerate being called again after partial failure.
 */
export const SELF_HOST_MIGRATIONS = [{
  id: 'unified-pages-v2', from: 1, to: 2,
  run: async (context) => {
    const { runUnifiedPagesMigration } = await import('./unified-pages-migration.mjs');
    return runUnifiedPagesMigration(context);
  },
}];

export function planSelfHostMigrations(currentVersion, targetVersion, migrations = SELF_HOST_MIGRATIONS) {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error(`Invalid installed data schema version: ${currentVersion}`);
  }
  if (!Number.isInteger(targetVersion) || targetVersion < currentVersion) {
    throw new Error(`Cannot migrate schema ${currentVersion} to ${targetVersion}`);
  }
  const steps = [];
  let version = currentVersion;
  while (version < targetVersion) {
    const step = migrations.find((candidate) => candidate.from === version && candidate.to === version + 1);
    if (!step) throw new Error(`No migration registered from schema ${version} to ${version + 1}`);
    steps.push(step);
    version = step.to;
  }
  return steps;
}
