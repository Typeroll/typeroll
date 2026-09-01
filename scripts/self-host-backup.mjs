#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createSelfHostBackup, decodeBackupKey } from './lib/self-host-backup.mjs';
import { loadSelfHostEnvironment, reportError } from './lib/self-host-cli.mjs';
import { createSelfHostServices } from './lib/self-host-services.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string', default: '.env' },
    output: { type: 'string' },
  },
});

try {
  const { env } = loadSelfHostEnvironment(values['env-file']);
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
  const output = path.resolve(values.output ?? `backups/typeroll-${timestamp}`);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const services = await createSelfHostServices(env);
  const manifest = await createSelfHostBackup({
    services,
    outputDir: output,
    backupKey: decodeBackupKey(env.TYPEROLL_BACKUP_KEY),
  });
  console.log(`Encrypted backup ${manifest.backup_id} completed at ${output}.`);
  console.log(JSON.stringify(manifest.counts));
} catch (error) {
  reportError(error);
}
