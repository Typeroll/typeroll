import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { ownerFieldDescriptor, ownerEditorFields, ownerReviewReady, submitOwnerProposal, ProposalError } from '../../../../../../../lib/owner-proposals';
import { notifyOwnerReviewer } from '../../../../../../../lib/owner-review-notifications';

/** A verified app subject may propose changes; accepted Page content is never written here. */
const handle: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('content:owner')) return apiError('An owner-authorized installation credential is required', 403);
  if (!params.pageId) return apiError('Missing Page ID', 400);
  try {
    const { page, type, fields, revision } = await ownerFieldDescriptor(ctx, params.pageId);
    if (request.method === 'GET') {
      const response = apiResponse(ctx, { page_id: params.pageId, title: page.title, content_type: type.id, revision,
        review_ready: await ownerReviewReady(ctx), fields: await ownerEditorFields(ctx, page, fields) });
      response.headers.set('Cache-Control', 'private, no-store'); return response;
    }
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return apiError('Expected a change proposal', 400);
    const subject = request.headers.get('X-Typeroll-Owner-Subject') ?? '';
    const result = await submitOwnerProposal(ctx, params.pageId, { installationId: ctx.extensionIdentity.installationId, subjectId: subject }, input);
    // The proposal is durable before delivery. Notification failure never loses it.
    const notification = await notifyOwnerReviewer(ctx, result.proposal_id, process.env.PORTAL_PUBLIC_URL || new URL(request.url).origin).catch(() => ({ status: 'failed' }));
    return apiResponse(ctx, { ok: true, ...result, notification: notification.status,
      message: 'Your changes are awaiting review. The public profile has not changed.' }, 202);
  } catch (error) {
    if (error instanceof ProposalError) return apiError(error.message, error.status);
    throw error;
  }
};
export const GET = handle;
export const PUT = handle;
