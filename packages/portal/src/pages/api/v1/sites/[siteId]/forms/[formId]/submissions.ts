// GET /api/v1/sites/{siteId}/forms/{formId}/submissions
//
// Lists submissions received for one form. Newest first; cursor-paginated;
// capped at 200 per page. Useful for an agent helping a customer triage
// inbound leads ("show me the last 20 contact-form submissions").

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { FormSubmission } from '@typeroll/shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(c: { after_id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(s: string | null): { after_id: string } | null {
  if (!s) return null;
  try {
    const d = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return typeof d?.after_id === 'string' ? { after_id: d.after_id } : null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const formId = params.formId;
  if (!formId) return apiError('Missing formId');

  const store = getStore();
  // Confirm the form exists. Listing submissions for an unknown form would
  // silently return [] and mislead the agent into thinking the form has
  // no leads when actually the form id is wrong.
  const form = await store.getDoc(`${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`);
  if (!form) return apiError('Form not found', 404);

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  let subs = await store.listDocs<FormSubmission>(paths.submissions(ctx.orgId, ctx.siteId));
  subs = subs.filter((s) => s.form_id === formId);
  subs.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.id.localeCompare(b.id));
  if (cursor) {
    const idx = subs.findIndex((s) => s.id === cursor.after_id);
    subs = idx >= 0 ? subs.slice(idx + 1) : subs;
  }
  const slice = subs.slice(0, limit);
  const nextCursor = subs.length > limit ? encodeCursor({ after_id: slice[slice.length - 1]!.id }) : null;

  return apiResponse(ctx, {
    submissions: slice,
    next_cursor: nextCursor,
    form_id: formId,
  });
};
