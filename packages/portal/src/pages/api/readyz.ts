import type { APIRoute } from 'astro';
import { readinessReport } from '../../lib/readiness';

export const GET: APIRoute = async () => {
  const report = await readinessReport();
  return new Response(JSON.stringify(report), {
    status: report.ready ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};
