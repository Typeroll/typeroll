import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionFailure } from '../../../../../lib/publishing/http';
import { checkGithubPermissions } from '../../../../../lib/publishing/github-permissions';
export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await checkGithubPermissions(guard.value.orgId)); }
  catch (error) { return connectionFailure(error); }
};
