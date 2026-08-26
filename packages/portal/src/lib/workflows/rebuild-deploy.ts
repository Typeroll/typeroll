// REBUILD_DEPLOY workflow.
//
// Builds the site-template against the current content and pushes it to the
// configured host. Triggered manually, by chat ("deploy my site"), or by a
// publish event.

import type { WorkflowDef } from './types';
import { runDeploy } from '../deploy/runner';

export const rebuildDeployWorkflow: WorkflowDef = {
  type: 'rebuild_deploy',
  label: 'Rebuild & deploy',
  description: 'Build the static site from current content and push it to your host.',
  steps: [
    {
      name: 'build_and_deploy',
      label: 'Build and deploy',
      async run(ctx) {
        const env = (ctx.config.environment as 'staging' | 'production') ?? 'staging';
        ctx.log(`Building for ${env}…`);
        const result = await runDeploy({
          orgId: ctx.orgId,
          siteId: ctx.siteId,
          environment: env,
        });
        ctx.log(`Deployed to ${result.deploy?.url ?? '(no url)'} (id: ${result.deploy?.deployId})`);
        return {
          results: {
            deploy: result.deploy,
            environment: env,
            url: result.deploy?.url,
          },
        };
      },
    },
  ],
};
