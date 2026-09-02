#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildGcpSelfHostPlan } from './lib/self-host-gcp-plan.mjs';
import { doctorGcpSelfHostPlan } from './lib/self-host-gcp-reconcile.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'self-host.gcp.json' },
    json: { type: 'boolean', default: false },
  },
});

try {
  const configPath = path.resolve(values.config);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const result = doctorGcpSelfHostPlan(buildGcpSelfHostPlan(config));
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.status === 'pass' ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}\n`);
    }
  }
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
