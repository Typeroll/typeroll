#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { decodeBackupKey, restoreSelfHostBackup, verifySelfHostBackup } from './lib/self-host-backup.mjs';
import { loadSelfHostEnvironment, reportError, requireExactConfirmation } from './lib/self-host-cli.mjs';
import { createSelfHostServices } from './lib/self-host-services.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string', default: '.env' },
    backup: { type: 'string' },
    apply: { type: 'boolean', default: false },
    'empty-target': { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
    'allow-target-mismatch': { type: 'boolean', default: false },
    'confirm-project': { type: 'string' },
    'confirm-bucket': { type: 'string' },
    'confirm-backup': { type: 'string' },
  },
});

try {
  if (!values.backup) throw new Error('--backup is required');
  const { env } = loadSelfHostEnvironment(values['env-file']);
  const backupKey = decodeBackupKey(env.TYPEROLL_BACKUP_KEY);
  const verified = await verifySelfHostBackup({ backupDir: values.backup, backupKey });
  if (!values.apply) {
    console.log(JSON.stringify({
      verified: true,
      backup_id: verified.manifest.backup_id,
      created_at: verified.manifest.created_at,
      source: verified.manifest.source,
      data_schema_version: verified.manifest.data_schema_version,
      counts: verified.manifest.counts,
      mode: 'verify-only',
    }, null, 2));
  } else {
    if (values['empty-target'] === values.replace) {
      throw new Error('Choose exactly one restore mode: --empty-target or --replace');
    }
    const services = await createSelfHostServices(env);
    requireExactConfirmation(services.projectId, values['confirm-project'], 'Firebase project');
    requireExactConfirmation(services.bucket, values['confirm-bucket'], 'R2 bucket');
    requireExactConfirmation(verified.manifest.backup_id, values['confirm-backup'], 'Backup ID');
    const sourceMatches =
      verified.manifest.source.firebase_project_id === services.projectId &&
      verified.manifest.source.r2_bucket === services.bucket;
    if (!sourceMatches && !values['allow-target-mismatch']) {
      throw new Error('Backup source differs from the restore target; pass --allow-target-mismatch only for an intentional disaster-recovery target');
    }
    const manifest = await restoreSelfHostBackup({
      services,
      backupDir: values.backup,
      backupKey,
      mode: values.replace ? 'replace' : 'empty',
    });
    console.log(`Backup ${manifest.backup_id} restored to the confirmed Firebase project and R2 bucket.`);
  }
} catch (error) {
  reportError(error);
}
