import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionBody, connectionFailure } from '../../../../lib/publishing/http';
import { checkBuildEngine, readBuildEngine } from '../../../../lib/builds/cloudflare';
export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await readBuildEngine(guard.value.orgId)); }
  catch (error) { return connectionFailure(error); }
};
export const POST: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await checkBuildEngine(guard.value.orgId, await connectionBody(context.request) as Record<string, unknown>)); }
  catch (error) { return connectionFailure(error); }
};
