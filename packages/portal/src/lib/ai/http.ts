// HTTP helpers shared by the portal (/api/orgs/ai/*) and public API
// (/api/v1/organization/ai/*) routes for the Organization's AI settings.
// Responses are private and never cache; errors never echo request bodies,
// so a submitted key cannot come back in an error.

import { json } from '../access';
import { AiSettingsError } from './organization-ai';

const MAX_BODY_BYTES = 4096;

export const AI_SETTINGS_REFUSAL = 'An organization owner or admin must manage the AI assistant.';

export function privateJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** Bounded JSON object body. Messages never include the body. */
export async function aiJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new AiSettingsError('Send a JSON body (Content-Type: application/json).', 415, 'invalid_body');
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new AiSettingsError('The request body is too large.', 413, 'invalid_body');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new AiSettingsError('The request body is too large.', 413, 'invalid_body');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AiSettingsError('The request body is not a JSON object.', 400, 'invalid_body');
  }
}

/** Map a failure to a response. Unknown errors get a generic message only. */
export function aiSettingsFailure(error: unknown): Response {
  if (error instanceof AiSettingsError) {
    return privateJson({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
  }
  console.error('[ai] Organization AI settings request failed:', error instanceof Error ? error.name : 'unknown error');
  return privateJson({ error: 'The AI settings could not be changed. Try again.' }, 500);
}
