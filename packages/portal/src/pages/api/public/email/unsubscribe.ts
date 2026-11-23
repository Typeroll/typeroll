import type { APIRoute } from 'astro';
import { emailQueueUnsubscribe } from '../../../../lib/email/queue-unsubscribe';

export const GET: APIRoute = ({ request }) => emailQueueUnsubscribe(request);
export const POST: APIRoute = GET;
