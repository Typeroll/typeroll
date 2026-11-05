import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const deployTools: ToolDef[] = [
  {
    name: 'get_publication_impact',
    description: 'Read where a deploy lands and provisional net saved public-source changes against the selected version’s last verified publication. targets lists every public URL the publication serves (live domains first, then the temporary address); production: true means the site is cut over and a deploy publishes to live_domains. Reports additions, removals, shared inputs, metadata-only changes and unavailable baselines. Does not build or deploy. execution is automatic and reuse_verified is false before the build; inspect job.render_report afterwards for actual rendered/reused counts; source-level classification does not prove output reuse or cost savings.',
    inputSchema: { version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, 'publishing/impact', v(args.version)))),
  },
  {
    name: 'trigger_deploy',
    description:
      "Enqueue a deploy (static-page build → hosting) of the currently active version. Returns a job_id immediately; poll get_deploy_status until the status leaves queued/running. NOT for previewing iterative design/content edits — that's what get_preview_link is for (it renders live from the DB with no build). Reserve trigger_deploy for publishing, a stakeholder link to the compiled site, or pre-merge validation. Publishing to the temporary address ends at cutover: once a site serves its live custom domain, the same publication serves both, so every deploy of main is a production release. Then get the owner's approval and pass confirm_live_domains: true; without it a real deploy is refused with live_domain_confirmation_required, naming the live URLs and targets. Review changes on a cut-over site with get_preview_link (include_working_copy) or dry_run:true, which need no confirmation. The result reports production, live_domains and targets (live domains first, then the temporary address). Deploys build SAVED content only — unsaved drafts (working copies) are excluded, so commit_working_copy (or save:true on your writes) before deploying, or your changes won't ship. Customer publishing freezes a consistent saved source, then resumes source/Git/build-dispatch checkpoints without recapturing later edits. GitHub or Cloudflare performs rendering and media work. With dry_run:true, customer publishing validates frozen source without a Git push or external build; it does not prove an Astro build succeeds. Other self-hosted adapters may build locally without upload. Check the reported phase. All sites in an organization share one build engine: publish one site at a time, starting the next only when the previous job has finished and read_organization_build_engine shows no active_jobs. A domain switch waiting for DNS approval (awaiting_approval) does not block other sites.",
    inputSchema: {
      environment: z.enum(['production', 'staging']).optional(),
      confirm_live_domains: z.boolean().optional().describe('Required (true) for a real deploy of a cut-over site: acknowledges that the deploy publishes to the live domains named by get_publication_impact or the live_domain_confirmation_required error. Only after the site owner approved this production release. Not needed for dry_run or sites that are not cut over.'),
      allow_unsaved: z.boolean().optional().describe('Explicitly publish saved content while leaving the reported unsaved Pages/partials untouched. Only after owner confirmation.'),
      dry_run: z.boolean().optional().describe('Validate without publishing. Customer publishing checks frozen source only, including image links without an accessible name (publication_validation_failed); other adapters may build locally without upload.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'deploy', body, v(version));
      return ok(res);
    }),
  },
  {
    name: 'retry_deploy_verification',
    description: 'Retry only public verification of an already-served customer publication that failed with publication_observation_timeout or publication_cache_refresh_required/external/failed. Reuses the exact job, Git commit and build artifact; never builds, uploads or changes DNS. Requires completed build/candidate receipts, unchanged hosting and no newer deployment for this version. Does not publish later CMS edits. Each failed check may get a bounded refresh of only that path on the site\'s own address; zone-wide refreshes are never made. A removed content-addressed file that Cloudflare still serves with exactly the bytes its name hashes, while a fresh cache key returns 404, is accepted and reported in warnings/retained_immutable. A publication_cache_refresh_failed names the stale layer in cache_recovery.layer (upstream_cache, origin or unknown).',
    inputSchema: { job_id: z.string(), approve_cache_zone_id: z.string().min(1).optional().describe('Retired. Zone-wide cache refreshes are no longer offered and are refused with publication_cache_zone_refresh_retired; retry without it.'), version: versionParam },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.post(siteId, 'deploy', { retry_verification_job_id: args.job_id, ...(args.approve_cache_zone_id !== undefined ? { approve_cache_zone_id: args.approve_cache_zone_id } : {}) }, v(args.version)))),
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
      "Status of a single deploy job. Optional top-level build_progress reports the exact task status, attempt, step and completed/total files; not an overall percentage or ETA. Media preparation runs in windows of about 12 minutes that each save their position, so attempt rises in a healthy build: media_continuations counts those planned windows, retries counts failed runs started again, and deadline is when the build stops for good. Do not cancel while completed still rises. Returns { job, queued_for_seconds, queue_timeout_seconds }. job.targets and job.production, when present, record where the publication was admitted to publish and whether that included a live domain. job.status is one of queued | running | succeeded | failed. On a failed build, job.error names the failed step and the cause the step printed, job.failure.code is the reported code (e.g. media_build_process_exit_1) and job.failure.diagnostic holds { cause, lines } (the last 40 lines that step printed, credentials removed). On the Cloudflare build engine job.failure.provider_log also holds { step, build_id, summary, lines } from the provider's build log (last 60 lines). Read them before retrying; retrying does not fix a cause that is in the content or the build engine. job.warnings, when present, lists non-blocking findings of a deploy that still ran, for example a media file left out of the publication because it could not be published safely (an SVG that could not be sanitized); report them to the user. Polling cadence: ~5s for queued/running. job.render_report, when present, reports actual HTML mode (full/partial), rendered, reused, total and removed route counts plus a fallback reason. From Core 0.2.17, custom blocks and consumed image metadata are tracked per route; older caches require one full build. It does not measure media or provider startup savings. job.coordinator, when present, reports the last completed CMS phase and duration_ms for that attempt; external build waiting is excluded. Keep observing the same job across checkpoints; do not trigger duplicate deploys. A job stuck in 'queued' for longer than queue_timeout_seconds (default 300s) auto-flips to failed with phase='queue_timeout' — so a single poll past that timestamp returns the terminal state and you can stop polling.",
    inputSchema: { job_id: z.string(), include_provider: z.boolean().optional().describe('Also read the exact Git commit and Cloudflare build stages for a customer Git publication. Does not return build secrets.') },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get<Record<string, unknown>>(siteId, `deploys/${encodeURIComponent(args.job_id)}`);
      if (args.include_provider) return ok({ ...res, provider_build: await client.get(siteId, 'publishing/build', { job_id: args.job_id }) });
      return ok(res);
    }),
  },
];
