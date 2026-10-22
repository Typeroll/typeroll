import type { APIContext } from 'astro';
import { json, requireOrganizationOwnerOrAdmin } from '../access';
import { R2VerificationError } from './r2-verification-error';
import { ConnectionError } from './connections';
import { ProviderError } from './providers.mjs';

export async function publishingAdmin(context: Pick<APIContext, 'cookies'>) {
  // New account credentials never inherit the legacy roles_enforced=false
  // compatibility behavior, which treats every organization member as admin.
  return requireOrganizationOwnerOrAdmin(context.cookies, 'An organization owner or admin must manage publishing accounts');
}

export function privateJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function connectionFailure(error: unknown): Response {
  if (error instanceof R2VerificationError) return privateJson({ error: error.message, code: error.code, details: error.diagnostic }, error.status);
  if (error instanceof ConnectionError) return privateJson({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}), ...(error.code === 'import_storage_required' ? { settings_url: '/app/settings/publishing#media-title' } : {}) }, error.status);
  if (error instanceof ProviderError) {
    if (error.codes.includes(10042)) return privateJson({ code: 'r2_activation_required', error: 'R2 is not activated in the connected Cloudflare account. Open Storage & databases → R2 object storage → Overview in Cloudflare and complete the R2 subscription checkout, including billing details if requested. Then return to Typeroll and select I’ve activated R2 — check again. Connecting Cloudflare to Typeroll does not activate R2.' }, 409);
    return privateJson({ error: error.message }, 502);
  }
  return privateJson({ error: 'Publishing connection failed. Check the account setup and try again.' }, 502);
}

export async function connectionBody(request: Request): Promise<unknown> {
  // These endpoints use cookie sessions only, including if a caller also sends a Bearer header.
  const origin = new URL(process.env.PORTAL_PUBLIC_URL || request.url).origin;
  if (request.headers.get('origin') !== origin) throw new ConnectionError('Publishing connection requires a same-origin request', 403);
  return publishingJsonBody(request);
}

/** Shared bounded JSON parser for authenticated API and same-origin cookie handlers. */
export async function publishingJsonBody(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('Invalid JSON byte limit');
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ConnectionError('Expected JSON connection data', 415);
  // Bound both declared and streamed bodies; tokens are never reflected in errors.
  if (Number(request.headers.get('content-length')) > maxBytes) throw new ConnectionError('Connection data is too large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ConnectionError('Connection data is missing');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new ConnectionError('Connection data is too large', 413); }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  }
  catch { throw new ConnectionError('Invalid connection data'); }
}
