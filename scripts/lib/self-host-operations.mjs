import { randomUUID } from 'node:crypto';

import {
  SELF_HOST_CORE_VERSION,
  SELF_HOST_DATA_SCHEMA_READABLE_MAX,
  SELF_HOST_DATA_SCHEMA_READABLE_MIN,
  SELF_HOST_DATA_SCHEMA_VERSION,
  SELF_HOST_INSTALLATION_PATH,
  SELF_HOST_MIGRATIONS,
  planSelfHostMigrations,
} from './self-host-schema.mjs';

function validateInstallationIdentity(installation, services) {
  if (installation.firebase_project_id !== services.projectId) {
    throw new Error('Installation metadata belongs to another Firebase project');
  }
  if (installation.r2_bucket !== services.bucket) {
    throw new Error('Installation metadata belongs to another R2 bucket');
  }
  if (!Number.isInteger(installation.data_schema_version)) {
    throw new Error('Installation metadata has no valid data schema version');
  }
  return installation;
}

function validateReadableInstallation(installation, services) {
  validateInstallationIdentity(installation, services);
  if (
    installation.data_schema_version < SELF_HOST_DATA_SCHEMA_READABLE_MIN ||
    installation.data_schema_version > SELF_HOST_DATA_SCHEMA_READABLE_MAX
  ) {
    throw new Error(`Core cannot read installed data schema ${installation.data_schema_version}`);
  }
  return installation;
}

export async function bootstrapSelfHost({ services, adopt = false, now = () => new Date(), id = randomUUID }) {
  await services.objects.assertAccessible();
  const existing = await services.firestore.get(SELF_HOST_INSTALLATION_PATH);
  if (existing) return { created: false, installation: validateReadableInstallation(existing, services) };

  const [hasDocuments, hasUsers, hasObjects] = await Promise.all([
    services.firestore.hasAny(),
    services.auth.hasAny(),
    services.objects.hasAny(),
  ]);
  const hasExistingData = hasDocuments || hasUsers || hasObjects;
  if (hasExistingData && !adopt) {
    throw new Error('Existing Firestore, Auth, or R2 data found; rerun with --adopt only after verifying this is a Typeroll installation');
  }

  const timestamp = now().toISOString();
  const installation = {
    kind: 'typeroll_installation',
    installation_id: id(),
    firebase_project_id: services.projectId,
    r2_bucket: services.bucket,
    data_schema_version: SELF_HOST_DATA_SCHEMA_VERSION,
    core_version_at_bootstrap: SELF_HOST_CORE_VERSION,
    created_at: timestamp,
    updated_at: timestamp,
    adopted_existing_data: hasExistingData,
  };
  const created = await services.firestore.create(SELF_HOST_INSTALLATION_PATH, installation);
  if (created) return { created: true, installation };
  const raced = await services.firestore.get(SELF_HOST_INSTALLATION_PATH);
  return { created: false, installation: validateReadableInstallation(raced, services) };
}

export async function migrationStatus({
  services,
  migrations = SELF_HOST_MIGRATIONS,
  targetVersion = SELF_HOST_DATA_SCHEMA_VERSION,
}) {
  const installation = await services.firestore.get(SELF_HOST_INSTALLATION_PATH);
  if (!installation) throw new Error('Installation is not bootstrapped');
  validateInstallationIdentity(installation, services);
  const steps = planSelfHostMigrations(
    installation.data_schema_version,
    targetVersion,
    migrations,
  );
  return { installation, steps };
}

export async function applySelfHostMigrations({
  services,
  verifiedBackup,
  migrations = SELF_HOST_MIGRATIONS,
  targetVersion = SELF_HOST_DATA_SCHEMA_VERSION,
  now = () => new Date(),
  owner = randomUUID(),
}) {
  const { installation, steps } = await migrationStatus({ services, migrations, targetVersion });
  if (steps.length === 0) return { applied: [], installation };
  if (!verifiedBackup) throw new Error('A verified pre-migration backup is required');
  const manifest = verifiedBackup.manifest;
  if (
    manifest.source.firebase_project_id !== services.projectId ||
    manifest.source.r2_bucket !== services.bucket ||
    manifest.data_schema_version !== installation.data_schema_version
  ) {
    throw new Error('Pre-migration backup does not match the active installation');
  }

  const started = now();
  const expiresAt = new Date(started.valueOf() + 30 * 60 * 1_000).toISOString();
  if (!await services.firestore.acquireMigrationLock(SELF_HOST_INSTALLATION_PATH, owner, started.toISOString(), expiresAt)) {
    throw new Error('Another migration holds the installation lock');
  }
  const applied = [];
  let heartbeatError;
  const heartbeat = setInterval(async () => {
    try {
      const renewed = await services.firestore.renewMigrationLock(
        SELF_HOST_INSTALLATION_PATH,
        owner,
        new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      );
      if (!renewed) heartbeatError = new Error('Migration lock ownership was lost');
    } catch (error) {
      heartbeatError = error;
    }
  }, 60_000);
  heartbeat.unref();
  let migrationError;
  try {
    for (const step of steps) {
      if (heartbeatError) throw heartbeatError;
      await step.run({ services });
      if (heartbeatError) throw heartbeatError;
      const updatedAt = now().toISOString();
      await services.firestore.update(SELF_HOST_INSTALLATION_PATH, {
        data_schema_version: step.to,
        updated_at: updatedAt,
        last_migrated_at: updatedAt,
        last_migration_id: step.id,
      });
      applied.push(step.id);
    }
  } catch (error) {
    migrationError = error;
    throw error;
  } finally {
    clearInterval(heartbeat);
    try {
      await services.firestore.releaseMigrationLock(SELF_HOST_INSTALLATION_PATH, owner);
    } catch (releaseError) {
      if (!migrationError) throw releaseError;
    }
  }
  return { applied, installation: await services.firestore.get(SELF_HOST_INSTALLATION_PATH) };
}
