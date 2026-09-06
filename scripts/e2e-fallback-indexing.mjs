#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { requireExactConfirmation, reportError } from './lib/e2e-cli.mjs';
import { runFallbackIndexingJourney } from './lib/e2e-fallback-indexing.mjs';
import { resolveE2ETarget, checkE2ETarget } from './lib/e2e-target.mjs';

const { values } = parseArgs({
  options: { 'confirm-site': { type: 'string' } },
});

try {
  const target = resolveE2ETarget(process.env);
  if (!target.isRemote || target.kind !== 'cloud') {
    throw new Error('The fallback indexing journey requires the permanent Cloud staging target');
  }
  const siteId = 'e2e-core-site';
  requireExactConfirmation(siteId, values['confirm-site'], 'E2E site');
  const apiKey = process.env.TYPEROLL_E2E_API_KEY?.trim();
  if (!apiKey) throw new Error('TYPEROLL_E2E_API_KEY is required');
  await checkE2ETarget(target);
  const result = await runFallbackIndexingJourney({
    portalUrl: target.portalUrl,
    apiKey,
  });
  console.log(
    `Fallback indexing journey passed on ${result.origin}; ` +
    `HEAD ${result.headStatus}, GET ${result.getStatus}, X-Robots-Tag ${result.xRobotsTag}.`,
  );
} catch (error) {
  reportError(error);
}
