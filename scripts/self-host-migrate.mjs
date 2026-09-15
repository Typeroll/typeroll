#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { decodeBackupKey, verifySelfHostBackup } from './lib/self-host-backup.mjs';
import { loadSelfHostEnvironment, reportError, requireExactConfirmation } from './lib/self-host-cli.mjs';
import { applySelfHostMigrations, migrationStatus } from './lib/self-host-operations.mjs';
import { prepareUnifiedPagesMigration } from './lib/unified-pages-migration.mjs';
import { createSelfHostServices } from './lib/self-host-services.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string', default: '.env' },
    apply: { type: 'boolean', default: false },
    'writers-stopped': { type: 'boolean', default: false },
    backup: { type: 'string' },
    'confirm-project': { type: 'string' },
  },
});

try {
  const { env } = loadSelfHostEnvironment(values['env-file']);
  const services = await createSelfHostServices(env);
  const status = await migrationStatus({ services });
  let verifiedBackup;
  if (values.backup) verifiedBackup = await verifySelfHostBackup({
    backupDir: values.backup,
    backupKey: decodeBackupKey(env.TYPEROLL_BACKUP_KEY),
    forMigration: true,
  });
  if (!values.apply) {
    const details = verifiedBackup && status.steps.some(step => step.id === 'unified-pages-v2')
      ? (await prepareUnifiedPagesMigration({ verifiedBackup, types: services.firestore.types })).reports : undefined;
    console.log(JSON.stringify({
      current_schema: status.installation.data_schema_version,
      target_schema: status.steps.at(-1)?.to ?? status.installation.data_schema_version,
      pending_migrations: status.steps.map((step) => step.id),
      mode: 'dry-run',
      sites: details,
      note: details ? 'Content migration planned from the verified backup; no data was changed.' : 'Pass --backup to validate every site before applying.',
    }, null, 2));
  } else {
    requireExactConfirmation(services.projectId, values['confirm-project'], 'Firebase project');
    if (status.steps.length && !verifiedBackup) throw new Error('--backup is required when migrations are pending');
    const result = await applySelfHostMigrations({ services, verifiedBackup, writersStopped: values['writers-stopped'] });
    console.log(`Applied ${result.applied.length} migration(s); data schema is ${result.installation.data_schema_version}.`);
  }
} catch (error) {
  reportError(error);
}
