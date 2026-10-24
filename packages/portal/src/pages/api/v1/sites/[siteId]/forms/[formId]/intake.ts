import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { extensionIntake, IntakeError } from '../../../../../../../lib/forms/extension-intake';

/** A paired installation collects private answers for its own site-bound form. */
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('forms:execute') || !params.formId) return apiError('An authorized installation is required', 403);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 64 * 1024) return apiError('Intake request is too large', 413);
  try {
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { return apiError('Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid intake');
    if (body.notifications && !ctx.extensionIdentity.scopes.includes('email:send')) return apiError('Email permission is required for intake notifications', 403);
    const response = apiResponse(ctx, await extensionIntake(getStore(), ctx.orgId, ctx.siteId, ctx.extensionIdentity.installationId, params.formId, body));
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof IntakeError) return apiError(error.message, error.status);
    throw error;
  }
};
