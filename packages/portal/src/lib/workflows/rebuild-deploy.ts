// REBUILD_DEPLOY workflow.
//
// Publishes the site's saved content through the same deploy queue as
// trigger_deploy: the publication is frozen and built by the organization's
// build engine and deployed to its hosting. The step returns once the deploy
// job is accepted; the job (get_deploy_status) reports the publication itself.
// Starting a production run of a cut-over site already required
// confirm_live_domains (workflows/service.ts).

import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { WorkflowDef } from './types';

export const rebuildDeployWorkflow: WorkflowDef = {
  type: 'rebuild_deploy',
  label: 'Rebuild & deploy',
  description: 'Build the static site from current content and push it to your host.',
  steps: [
    {
      name: 'build_and_deploy',
      label: 'Build and deploy',
      async run(ctx) {
        const environment = ctx.config.environment === 'production' ? 'production' : 'staging';
        const versionId = typeof ctx.config.version === 'string' && ctx.config.version ? ctx.config.version : MAIN_VERSION_ID;
        const { publicationTargets } = await import('../publishing/publication-targets');
        const { getDeployQueue } = await import('../deploy/queue');
        const targets = await publicationTargets(ctx.orgId, ctx.siteId, versionId, environment);
        const jobId = await ctx.store.addDoc(paths.deploys(ctx.orgId, ctx.siteId), {
          version_id: versionId,
          environment,
          status: 'queued',
          started_at: new Date().toISOString(),
          triggered_by: `workflow:${ctx.workflowId}`,
          dry_run: false,
          targets: targets.targets,
          production: targets.production,
          ...(targets.production ? { live_domains_confirmed: true } : {}),
        });
        try {
          await getDeployQueue().enqueue({ jobId, orgId: ctx.orgId, siteId: ctx.siteId, versionId, environment });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await ctx.store.updateDoc(paths.deploy(ctx.orgId, ctx.siteId, jobId), {
            status: 'failed', phase: 'enqueue_failed', finished_at: new Date().toISOString(), error: message,
          });
          throw error;
        }
        ctx.log(`Publication ${jobId} accepted for ${environment}; follow it with get_deploy_status.`);
        return {
          results: {
            job_id: jobId,
            environment,
            production: targets.production,
            targets: targets.targets,
          },
        };
      },
    },
  ],
};
