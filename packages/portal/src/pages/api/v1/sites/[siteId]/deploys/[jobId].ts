// GET /api/v1/sites/{siteId}/deploys/{jobId}
//
// One deploy job's status. queued → running → succeeded | failed. The
// agent polls this until status leaves the running set.
//
// Adds visibility for stuck-queued cases (MCP-FEEDBACK-2): the
// response includes queued_for_seconds + a soft staleness signal so an
// agent can decide whether to retry or give up. Auto-flips status to
// failed:queue_timeout if the job has been in queued for more than
// QUEUE_TIMEOUT_SECONDS — Cloud Tasks normally dispatches within
// seconds, so anything >5 min means the worker isn't being called.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { publicUrlsFor } from '../../../../../../lib/site-public-urls';
import { paths } from '@typeroll/shared';
import type { DeployJob } from '@typeroll/shared';

// 5 minutes. Real deploys dispatch in seconds; 5 min in queued means
// the Cloud Tasks worker isn't being invoked (auth, networking, or
// queue config issue). Letting the job hang forever made agents poll
// indefinitely — flipping it to failed gives them a terminal state.
const QUEUE_TIMEOUT_SECONDS = 5 * 60;

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const jobId = params.jobId;
  if (!jobId) return apiError('Missing jobId');
  const store = getStore();
  const jobPath = paths.deploy(ctx.orgId, ctx.siteId, jobId);
  let doc = await store.getDoc<DeployJob>(jobPath);
  if (!doc) return apiError('Not found', 404);

  // Compute waited-time + auto-fail if it's been queued too long.
  const queuedAt = doc.started_at ? new Date(doc.started_at).getTime() : null;
  const queuedFor = queuedAt
    ? Math.floor((Date.now() - queuedAt) / 1000)
    : null;

  if (doc.status === 'queued' && queuedFor !== null && queuedFor > QUEUE_TIMEOUT_SECONDS) {
    const finishedAt = new Date().toISOString();
    const patch: Partial<DeployJob> = {
      status: 'failed',
      phase: 'queue_timeout',
      error: `Cloud Tasks worker didn't pick up the job within ${QUEUE_TIMEOUT_SECONDS}s. The queue or worker auth is likely misconfigured. Re-trigger the deploy after checking the deploy-worker route.`,
      finished_at: finishedAt,
    };
    await store.updateDoc(jobPath, patch as Record<string, unknown>);
    doc = { ...doc, ...patch } as DeployJob;
  }

  const siteUrls = publicUrlsFor(ctx.site);
  return apiResponse(ctx, {
    job: doc,
    queued_for_seconds: queuedFor,
    // Hint for agents polling: stop after this many seconds in queued
    // — at that point we'll auto-flip to failed anyway, so a poll
    // afterwards returns the terminal state.
    queue_timeout_seconds: QUEUE_TIMEOUT_SECONDS,
    // When the job deploy_url is null (main-branch deploy), the site's
    // public URL is still available here so agents know where to look.
    site_urls: siteUrls,
  });
};
