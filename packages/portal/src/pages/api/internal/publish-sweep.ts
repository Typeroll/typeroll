// Scheduled-publishing sweep trigger. Production: a Cloud Scheduler job
// POSTs here every few minutes with a Google-signed OIDC token (same
// contract as the deploy worker — see lib/internal-auth.ts). Local dev:
// middleware starts an in-process interval, and DEPLOY_WORKER_SKIP_AUTH=1
// lets you curl it directly.
//
// The sweep itself is idempotent (status-gated, schedule fields cleared on
// fire), so at-least-once triggering and overlapping calls are safe.

import type { APIRoute } from 'astro';
import { verifyInternalOidc } from '../../../lib/internal-auth';
import { runPublishSweep } from '../../../lib/scheduled-publish';

export const POST: APIRoute = async ({ request }) => {
  const skipAuth = process.env.DEPLOY_WORKER_SKIP_AUTH === '1';
  if (!skipAuth) {
    const ok = await verifyInternalOidc(request);
    if (!ok) return new Response('Unauthorized', { status: 401 });
  }

  const result = await runPublishSweep();
  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
