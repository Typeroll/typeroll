#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { reportError, requireExactConfirmation } from './lib/e2e-cli.mjs';
import {
  createEndpointPersonaServices,
  readPersonaManifest,
  readSecurePersonaEnvFile,
  seedLocalPersonas,
  seedRemotePersonas,
  verifyLocalPersonas,
  verifyRemotePersonas,
} from './lib/e2e-personas.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    environment: { type: 'string', default: 'local' },
    'fixtures-dir': { type: 'string' },
    'env-file': { type: 'string' },
    'confirm-target': { type: 'string' },
  },
});

try {
  const command = positionals[0];
  if (command !== 'seed' && command !== 'verify') throw new Error('Command must be seed or verify');
  if (!['local', 'self_host', 'cloud'].includes(values.environment)) {
    throw new Error('--environment must be local, self_host, or cloud');
  }
  const manifest = readPersonaManifest();
  if (values.environment === 'local') {
    if (!values['fixtures-dir']) throw new Error('--fixtures-dir is required for local persona operations');
    const result = command === 'seed'
      ? seedLocalPersonas({ fixtureRoot: values['fixtures-dir'], manifest })
      : verifyLocalPersonas({ fixtureRoot: values['fixtures-dir'], manifest });
    console.log(`Local E2E personas ${command === 'seed' ? 'seeded' : 'verified'} (${result.personaCount}).`);
  } else {
    const env = values['env-file'] ? readSecurePersonaEnvFile(values['env-file']) : process.env;
    const services = createEndpointPersonaServices(env);
    if (command === 'seed') requireExactConfirmation(services.target, values['confirm-target'], 'Seeding endpoint host');
    const result = command === 'seed'
      ? await seedRemotePersonas({ services, env, manifest })
      : await verifyRemotePersonas({ services, env, manifest });
    console.log(`Remote E2E personas ${command === 'seed' ? 'seeded and verified' : 'verified'} at ${result.target} (${result.personaCount}).`);
  }
} catch (error) {
  reportError(error);
}
