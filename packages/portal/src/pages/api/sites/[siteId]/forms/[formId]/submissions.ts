// Cookie-auth admin: list submissions for one form (newest first, paginated).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { FormSubmission, FormWebhookDelivery } from '@typeroll/shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(after_id: string): string {
  return Buffer.from(JSON.stringify({ after_id }), 'utf8').toString('base64url');
}
function decodeCursor(s: string | null): string | null {
  if (!s) return null;
  try {
    const d = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return typeof d?.after_id === 'string' ? d.after_id : null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const formId = params.formId;
  if (!formId) return json({ error: 'Missing formId' }, 400);

  const store = getStore();
  if (!(await store.getDoc(`${paths.forms(owner_org_id, site.id)}/${formId}`))) {
    return json({ error: 'Form not found' }, 404);
  }

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));
  const after = decodeCursor(url.searchParams.get('cursor'));

  let subs = await store.listDocs<FormSubmission>(paths.submissions(owner_org_id, site.id));
  subs = subs.filter((s) => s.form_id === formId);
  subs.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.id.localeCompare(b.id));
  if (after) {
    const idx = subs.findIndex((s) => s.id === after);
    if (idx >= 0) subs = subs.slice(idx + 1);
  }
  const slice = subs.slice(0, limit);
  const next_cursor = subs.length > limit ? encodeCursor(slice[slice.length - 1]!.id) : null;
  let submissions: Array<FormSubmission & { webhook_deliveries?: Partial<FormWebhookDelivery>[] }> = slice;
  if (guard.value.permission === 'admin') {
    const deliveries = await store.listDocs<FormWebhookDelivery>(
      paths.formWebhookDeliveries(owner_org_id, site.id),
    );
    submissions = slice.map((submission) => ({
      ...submission,
      webhook_deliveries: deliveries
        .filter((delivery) => delivery.submission_id === submission.id)
        .map((delivery) => ({
          webhook_id: delivery.webhook_id,
          status: delivery.status,
          attempts: delivery.attempts,
          response_status: delivery.response_status,
          last_error: delivery.last_error,
          updated_at: delivery.updated_at,
        })),
    }));
  }
  return json({ submissions, next_cursor, form_id: formId });
};
