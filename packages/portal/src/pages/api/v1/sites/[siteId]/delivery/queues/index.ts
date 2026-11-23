import type { APIRoute } from 'astro';
import { emailQueueApi } from '../../../../../../../lib/email/queue-api';

export const POST: APIRoute = ({ request, params }) => emailQueueApi(request, params.siteId);
