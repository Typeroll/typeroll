import type { APIRoute } from 'astro';
import { organizationEmailPublicApi } from '../../../../lib/email/organization-email-api';

export const GET: APIRoute = ({ request }) => organizationEmailPublicApi(request);
export const PUT: APIRoute = GET;
export const POST: APIRoute = GET;
export const DELETE: APIRoute = GET;
