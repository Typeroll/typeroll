import type { APIRoute } from 'astro';
import { extensionIssuerDiscovery } from '../../lib/extensions/auth';

export const GET: APIRoute = async () => new Response(JSON.stringify(extensionIssuerDiscovery()), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
});
