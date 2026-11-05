// POST /api/internal/store-transfer — self-hosted backup and restore of the
// document store (lib/runtime/store-transfer.ts). Answers 404 unless the
// request carries TYPEROLL_STORE_TRANSFER_TOKEN.
import type { APIRoute } from 'astro';
import { handleStoreTransfer, storeTransferAuthorized, StoreTransferError } from '../../../lib/runtime/store-transfer';
import { MigrationRunError } from '../../../lib/migration/worker-run';

export const prerender = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export const POST: APIRoute = async ({ request }) => {
  if (!storeTransferAuthorized(request.headers.get('authorization'))) return new Response('Not found', { status: 404 });
  const text = await request.text();
  if (text.length > 256 * 1024) return json({ error: 'Request too large' }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { return json({ error: 'Invalid JSON' }, 400); }
  try {
    return json(await handleStoreTransfer(body));
  } catch (error) {
    if (error instanceof StoreTransferError) return json({ error: error.message }, error.status);
    if (error instanceof MigrationRunError) return json({ error: error.message }, 409);
    console.error('[store-transfer] failed:', error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'Store transfer failed' }, 500);
  }
};
