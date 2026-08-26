import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const deployTools: ToolDef[] = [
  {
    name: 'trigger_deploy',
    description:
      "Enqueue a deploy (static-page build → hosting) of the currently active version. Returns a job_id immediately; poll get_deploy_status until the status leaves queued/running. NOT for previewing iterative design/content edits — that's what get_preview_link is for (it renders live from the DB with no build). Reserve trigger_deploy for publishing, a stakeholder link to the compiled site, or pre-merge validation. Deploys build SAVED content only — unsaved drafts (working copies) are excluded, so commit_working_copy (or save:true on your writes) before deploying, or your changes won't ship. With `dry_run: true`, the deploy runs through every step EXCEPT the hosting-adapter upload — useful for validating a structural change (new collection routes, schema bump, mode switch) without risking the live site. A dry_run job that succeeds proves the build is clean; one that fails returns the same astro stack-trace in get_deploy_status.error as a real deploy would.",
    inputSchema: {
      environment: z.enum(['production', 'staging']).optional(),
      dry_run: z.boolean().optional().describe('Run the build but skip the CDN upload. The job ends in succeeded/failed the same way a real deploy does.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'deploy', body, v(version));
      return ok(res);
    }),
  },
  {
    name: 'list_deploys',
    description: 'Recent deploy jobs, newest first (capped at 50).',
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.get(siteId, 'deploys');
      return ok(res);
    }),
  },
  {
    name: 'get_deploy_status',
    description:
      "Status of a single deploy job. Returns { job, queued_for_seconds, queue_timeout_seconds }. job.status is one of queued | running | succeeded | failed. Polling cadence: ~5s for queued/running. A job stuck in 'queued' for longer than queue_timeout_seconds (default 300s) auto-flips to failed with phase='queue_timeout' — so a single poll past that timestamp returns the terminal state and you can stop polling.",
    inputSchema: { job_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, `deploys/${encodeURIComponent(args.job_id)}`);
      return ok(res);
    }),
  },
];
