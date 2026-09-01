#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { loadSelfHostEnvironment, reportError } from './lib/self-host-cli.mjs';
import { bootstrapSelfHost } from './lib/self-host-operations.mjs';
import { createSelfHostServices } from './lib/self-host-services.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string', default: '.env' },
    adopt: { type: 'boolean', default: false },
  },
});

try {
  const { env } = loadSelfHostEnvironment(values['env-file']);
  const services = await createSelfHostServices(env);
  const result = await bootstrapSelfHost({ services, adopt: values.adopt });
  console.log(result.created
    ? `Self-host installation bootstrapped at data schema ${result.installation.data_schema_version}.`
    : `Self-host installation already bootstrapped at data schema ${result.installation.data_schema_version}.`);
} catch (error) {
  reportError(error);
}
