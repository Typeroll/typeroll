import type { APIRoute } from 'astro';
import { organizationEmailCookie } from '../../../../lib/email/organization-email-api';

export const GET: APIRoute = ({ request, cookies }) => organizationEmailCookie(request, cookies);
export const PUT: APIRoute = GET;
export const POST: APIRoute = GET;
export const DELETE: APIRoute = GET;
