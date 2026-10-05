import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionBody, connectionFailure } from '../../../../lib/publishing/http';
import { listHostingGroups, saveHostingGroup } from '../../../../lib/publishing/hosting-groups';
import { cloudflareChoices, cloudflareSetup } from '../../../../lib/publishing/cloudflare-oauth';
import { currentCloudflareDiagnosis } from '../../../../lib/publishing/cloudflare-diagnosis';

export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const groups = await listHostingGroups(guard.value.orgId);
    // Choices and an unfinished attempt belong to the signed-in person's own OAuth flow.
    return privateJson({ groups: await Promise.all(groups.map(async group => ({ ...group, account_choices: await cloudflareChoices(guard.value, group.id),
      cloudflare_diagnosis: await currentCloudflareDiagnosis(guard.value.orgId, group.id, guard.value) }))), cloudflare_setup: cloudflareSetup() });
  } catch (error) { return connectionFailure(error); }
};
export const POST: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await saveHostingGroup(guard.value.orgId, await connectionBody(context.request) as Record<string, unknown>)); }
  catch (error) { return connectionFailure(error); }
};
export const PUT = POST;
