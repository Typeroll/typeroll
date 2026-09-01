import type { APIRoute } from 'astro';
import { releaseManifest } from '../../lib/release';

export const GET: APIRoute = () => new Response(JSON.stringify(releaseManifest()), {
  status: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
});
