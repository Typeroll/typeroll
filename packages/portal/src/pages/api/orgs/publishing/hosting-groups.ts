import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionBody, connectionFailure } from '../../../../lib/publishing/http';
import { listHostingGroups, saveHostingGroup } from '../../../../lib/publishing/hosting-groups';
import { cloudflareChoices } from '../../../../lib/publishing/cloudflare-oauth';

export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const groups = await listHostingGroups(guard.value.orgId);
    return privateJson({ groups: await Promise.all(groups.map(async group => ({ ...group, account_choices: await cloudflareChoices(guard.value, group.id) }))) });
  } catch (error) { return connectionFailure(error); }
};
export const POST: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await saveHostingGroup(guard.value.orgId, await connectionBody(context.request) as Record<string, unknown>)); }
  catch (error) { return connectionFailure(error); }
};
export const PUT = POST;
