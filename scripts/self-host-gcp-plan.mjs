#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildGcpSelfHostPlan } from './lib/self-host-gcp-plan.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'self-host.gcp.json' },
  },
});

try {
  const configPath = path.resolve(values.config);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const plan = buildGcpSelfHostPlan(config);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
