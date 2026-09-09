import type { APIRoute } from 'astro';
import { runnerRequest } from '../../../../../lib/builds/runner-http';
export const POST: APIRoute = ({ request, params }) => runnerRequest(request, params.org ?? '', params.action ?? '');
