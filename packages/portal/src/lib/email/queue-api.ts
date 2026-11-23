import { apiError, apiResponse, requireApiKey } from '../api-auth';
import { publishingJsonBody } from '../publishing/http';
import { applicationEmailQueues } from './queue-runtime';
import { EmailQueueError, publicEmailQueue } from './queue';
import { siteEmailQueuePolicy } from './configuration';
import { ConnectionError } from '../publishing/connections';

export async function emailQueueApi(request: Request, siteId: string | undefined, queueId?: string) {
  const guard = await requireApiKey(request, siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('email:send')) return apiError('An email-authorized installation credential is required', 403);
  const scope = { orgId: ctx.orgId, siteId: ctx.siteId, installationId: ctx.extensionIdentity.installationId };
  const queues = applicationEmailQueues();
  try {
    if (request.method === 'GET' && queueId) return apiResponse(ctx, { queue: publicEmailQueue(await queues.read(scope, queueId)) });
    if (request.method !== 'POST') return apiError('Method not allowed', 405);
    const input = await publishingJsonBody(request, queueId ? 8192 : 1024 * 1024);
    const policy = await siteEmailQueuePolicy(scope.orgId, scope.siteId);
    if ((!queueId || ['start', 'resume'].includes(String(input.action))) && (!policy.ready || !policy.daily_limit)) throw new EmailQueueError('Configure an outgoing account and a positive campaign limit in Site email settings before starting', 409);
    const q = !queueId ? await queues.create(scope, { ...input,
      daily_limit: Math.min(Number(input.daily_limit ?? policy.daily_limit), policy.daily_limit),
      interval_minutes: Math.max(Number(input.interval_minutes ?? policy.minimum_interval_minutes), policy.minimum_interval_minutes),
    } as unknown as Parameters<typeof queues.create>[1])
      : input.action === 'reconcile' ? await queues.reconcile(scope, queueId)
      : input.action === 'cancel_entry' ? await queues.cancelEntry(scope, queueId, String(input.entry_id ?? ''), String(input.fingerprint ?? ''))
      : await queues.control(scope, queueId, input.action as 'start' | 'pause' | 'resume' | 'cancel', String(input.fingerprint ?? ''));
    return apiResponse(ctx, { queue: publicEmailQueue(q) });
  } catch (error) {
    const known = error instanceof EmailQueueError || error instanceof ConnectionError;
    return apiError(known ? error.message : 'The email queue operation could not be confirmed', known ? error.status : 503, ctx);
  }
}
