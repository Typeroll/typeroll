#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { requireExactConfirmation, reportError } from './lib/e2e-cli.mjs';
import { runAgentJourney } from './lib/e2e-agent-journey.mjs';
import { resolveE2ETarget, checkE2ETarget } from './lib/e2e-target.mjs';

const { values } = parseArgs({
  options: { 'confirm-site': { type: 'string' } },
});

try {
  const target = resolveE2ETarget(process.env);
  if (!target.isRemote) throw new Error('The agent journey requires a permanent remote E2E target');
  // The journeys publish, so the site needs working customer publishing: the
  // caller names it twice (environment and flag) and passes a key for it.
  const siteId = process.env.TYPEROLL_E2E_JOURNEY_SITE?.trim();
  if (!siteId) throw new Error('TYPEROLL_E2E_JOURNEY_SITE is required');
  requireExactConfirmation(siteId, values['confirm-site'], 'E2E site');
  const apiKey = process.env.TYPEROLL_E2E_JOURNEY_API_KEY?.trim();
  if (!apiKey) throw new Error('TYPEROLL_E2E_JOURNEY_API_KEY is required');
  await checkE2ETarget(target);
  const result = await runAgentJourney({ portalUrl: target.portalUrl, apiKey, siteId });
  console.log(`Remote agent journey passed on ${target.kind}; preview ${result.preview}, dry-run deploy ${result.dryRunDeploy}, branch cleaned.`);
} catch (error) {
  reportError(error);
}
