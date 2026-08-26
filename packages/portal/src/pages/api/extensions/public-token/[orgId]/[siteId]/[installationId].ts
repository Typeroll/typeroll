import type { APIRoute } from 'astro';
import {
  issuePublicExtensionToken,
  publicExtensionCors,
  PublicExtensionTokenError,
} from '../../../../../../lib/extensions/public-token';

function ids(params: Record<string, string | undefined>) {
  if (!params.orgId || !params.siteId || !params.installationId) return null;
  return { orgId: params.orgId, siteId: params.siteId, installationId: params.installationId };
}

function errorResponse(error: unknown, cors: Record<string, string> = {}) {
  const status = error instanceof PublicExtensionTokenError ? error.status : 500;
  const message = error instanceof PublicExtensionTokenError ? error.message : 'Token issuance failed';
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
}

export const OPTIONS: APIRoute = async ({ request, params }) => {
  const parsed = ids(params);
  if (!parsed) return errorResponse(new PublicExtensionTokenError('Missing identifier', 400));
  try {
    return new Response(null, { status: 204, headers: await publicExtensionCors({ request, ...parsed }) });
  } catch (error) {
    return errorResponse(error);
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const parsed = ids(params);
  if (!parsed) return errorResponse(new PublicExtensionTokenError('Missing identifier', 400));
  let cors: Record<string, string> = {};
  try {
    cors = await publicExtensionCors({ request, ...parsed });
    const result = await issuePublicExtensionToken({ request, ...parsed });
    return new Response(JSON.stringify({ token: result.token, token_type: 'Typeroll-Extension', expires_in: result.expires_in }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...result.cors },
    });
  } catch (error) {
    return errorResponse(error, cors);
  }
};
