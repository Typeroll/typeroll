import type { APIContext } from 'astro';
import { json, requireFullSession, requireOrgAdmin } from '../access';
import { ConnectionError } from './connections';
import { ProviderError } from './providers.mjs';
import { getStore } from '../datastore';
import { paths } from '@typeroll/shared';

export async function publishingAdmin(context: Pick<APIContext, 'cookies'>) {
  const session = await requireFullSession(context.cookies);
  if (!session.ok) return session;
  const admin = await requireOrgAdmin(session.value);
  if (!admin.ok) return admin;
  // New account credentials never inherit the legacy roles_enforced=false
  // compatibility behavior, which treats every organization member as admin.
  const member = await getStore().getDoc<{ role: string }>(`${paths.members(session.value.orgId)}/${session.value.userId}`);
  if (member?.role !== 'owner' && member?.role !== 'admin') {
    return { ok: false as const, response: privateJson({ error: 'An organization owner or admin must manage publishing accounts' }, 403) };
  }
  return session;
}

export function privateJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function connectionFailure(error: unknown): Response {
  if (error instanceof ConnectionError) return privateJson({ error: error.message }, error.status);
  if (error instanceof ProviderError) return privateJson({ error: error.message }, 502);
  return privateJson({ error: 'Publishing connection failed. Check the account setup and try again.' }, 502);
}

export async function connectionBody(request: Request): Promise<unknown> {
  // These endpoints use cookie sessions only, including if a caller also sends a Bearer header.
  const origin = new URL(process.env.PORTAL_PUBLIC_URL || request.url).origin;
  if (request.headers.get('origin') !== origin) throw new ConnectionError('Publishing connection requires a same-origin request', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ConnectionError('Expected JSON connection data', 415);
  // Bound both declared and streamed bodies; tokens are never reflected in errors.
  if (Number(request.headers.get('content-length')) > 8192) throw new ConnectionError('Connection data is too large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ConnectionError('Connection data is missing');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new ConnectionError('Connection data is too large', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ConnectionError('Invalid connection data'); }
}
