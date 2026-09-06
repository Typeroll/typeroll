#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createProviderClient, githubInstallationClient } from './lib/customer-publishing.mjs';
import { buildPublishingProbePlan, prepareProbeDirectory, runPublishingProbe, probeR2Upload } from './lib/customer-publishing-probe.mjs';

try {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, prepare: { type: 'string' }, apply: { type: 'boolean', default: false },
    'confirm-plan': { type: 'string' },
  } });
  if (!values.config || (values.apply && values.prepare)) throw new Error('Provide --config and choose either --prepare or --apply');
  const plan = buildPublishingProbePlan(JSON.parse(await fs.readFile(values.config, 'utf8')));
  let result = plan;
  if (values.prepare) {
    result = await prepareProbeDirectory(plan, path.resolve(values.prepare));
  } else if (values.apply) {
    if (values['confirm-plan'] !== plan.fingerprint) throw new Error('Review the plan and pass its exact fingerprint with --confirm-plan');
    const github = await githubInstallationClient({
      appId: plan.config.github_app_id, installationId: plan.config.github_installation_id,
      owner: plan.config.github_owner, privateKey: process.env.TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY,
    });
    const cloudflare = createProviderClient('Cloudflare', process.env.TYPEROLL_PUBLISH_CLOUDFLARE_TOKEN);
    result = await runPublishingProbe(plan, { github, cloudflare,
      probeMedia: (p) => probeR2Upload(p, {
        accessKeyId: process.env.TYPEROLL_PUBLISH_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.TYPEROLL_PUBLISH_R2_SECRET_ACCESS_KEY,
      }),
      log: (event) => process.stderr.write(`${event.phase}: ${event.resource}\n`),
    });
    if (result.state === 'failed') process.exitCode = 1;
    else if (result.state === 'pending') process.exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Publication probe failed');
  process.exitCode = 1;
}
