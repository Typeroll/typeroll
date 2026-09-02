#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildGcpSelfHostPlan } from './lib/self-host-gcp-plan.mjs';
import { applyGcpSelfHostPlan, buildGcpSelfHostApplyPreview } from './lib/self-host-gcp-reconcile.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'self-host.gcp.json' },
    phase: { type: 'string', default: 'all' },
    apply: { type: 'boolean', default: false },
    'confirm-project': { type: 'string' },
  },
});

try {
  const configPath = path.resolve(values.config);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const plan = buildGcpSelfHostPlan(config);

  if (!values.apply) {
    process.stdout.write(`${JSON.stringify(buildGcpSelfHostApplyPreview(plan, values.phase), null, 2)}\n`);
  } else {
    const result = applyGcpSelfHostPlan(plan, {
      phase: values.phase,
      confirmProject: values['confirm-project'],
      log(event) {
        process.stdout.write(`[${event.action}] ${event.resource}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
