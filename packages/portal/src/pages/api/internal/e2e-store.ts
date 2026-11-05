// POST /api/internal/e2e-store — document access for the local Playwright run
// (lib/e2e-store.ts). 404 outside local E2E mode.
import type { APIRoute } from 'astro';
import { authorizeE2EStore, E2EStoreError, handleE2EStore, MAX_E2E_STORE_BYTES } from '../../../lib/e2e-store';

export const prerender = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export const POST: APIRoute = async ({ request }) => {
  try {
    authorizeE2EStore(request);
    const text = await request.text();
    if (text.length > MAX_E2E_STORE_BYTES) return json({ error: 'Request too large' }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request' }, 400);
    return json(await handleE2EStore(body as Record<string, unknown>));
  } catch (error) {
    if (error instanceof E2EStoreError) return error.status === 404 ? new Response('Not found', { status: 404 }) : json({ error: error.message }, error.status);
    throw error;
  }
};
