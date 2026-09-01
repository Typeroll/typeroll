#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { decodeBackupKey, verifySelfHostBackup } from './lib/self-host-backup.mjs';
import { loadSelfHostEnvironment, reportError, requireExactConfirmation } from './lib/self-host-cli.mjs';
import { applySelfHostMigrations, migrationStatus } from './lib/self-host-operations.mjs';
import { createSelfHostServices } from './lib/self-host-services.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string', default: '.env' },
    apply: { type: 'boolean', default: false },
    backup: { type: 'string' },
    'confirm-project': { type: 'string' },
  },
});

try {
  const { env } = loadSelfHostEnvironment(values['env-file']);
  const services = await createSelfHostServices(env);
  const status = await migrationStatus({ services });
  if (!values.apply) {
    console.log(JSON.stringify({
      current_schema: status.installation.data_schema_version,
      target_schema: status.steps.at(-1)?.to ?? status.installation.data_schema_version,
      pending_migrations: status.steps.map((step) => step.id),
      mode: 'dry-run',
    }, null, 2));
  } else {
    requireExactConfirmation(services.projectId, values['confirm-project'], 'Firebase project');
    let verifiedBackup;
    if (status.steps.length > 0) {
      if (!values.backup) throw new Error('--backup is required when migrations are pending');
      verifiedBackup = await verifySelfHostBackup({
        backupDir: values.backup,
        backupKey: decodeBackupKey(env.TYPEROLL_BACKUP_KEY),
      });
    }
    const result = await applySelfHostMigrations({ services, verifiedBackup });
    console.log(`Applied ${result.applied.length} migration(s); data schema is ${result.installation.data_schema_version}.`);
  }
} catch (error) {
  reportError(error);
}
