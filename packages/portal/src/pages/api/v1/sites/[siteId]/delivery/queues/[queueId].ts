import type { APIRoute } from 'astro';
import { emailQueueApi } from '../../../../../../../lib/email/queue-api';

export const GET: APIRoute = ({ request, params }) => emailQueueApi(request, params.siteId, params.queueId);
export const POST: APIRoute = GET;
