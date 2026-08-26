import type { APIRoute } from 'astro';
import { extensionJwks } from '../../lib/extensions/auth';

export const GET: APIRoute = async () => new Response(JSON.stringify(extensionJwks()), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
});
