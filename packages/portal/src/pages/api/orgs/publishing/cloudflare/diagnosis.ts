import type { APIRoute } from 'astro';
import { ConnectionError } from '../../../../../lib/publishing/connections';
import { currentCloudflareDiagnosis } from '../../../../../lib/publishing/cloudflare-diagnosis';
import { recheckCloudflareDiagnosis } from '../../../../../lib/publishing/cloudflare-oauth';
import { getHostingGroup, hostingGroupId } from '../../../../../lib/publishing/hosting-groups';
import { connectionBody, connectionFailure, privateJson, publishingAdmin } from '../../../../../lib/publishing/http';

// GET  ?hosting_group=<id> — the signed-in person's current Cloudflare diagnosis.
// POST { action: 'recheck', hosting_group_id? } — check again: re-verify a saved
//      connection, or list and check the accounts of this person's consent from
//      the last hour and offer a new choice. Connects nothing; repeated calls
//      within five seconds return the same result.
export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const groupId = hostingGroupId(context.url.searchParams.get('hosting_group') ?? 'default');
    await getHostingGroup(guard.value.orgId, groupId);
    return privateJson({ diagnosis: await currentCloudflareDiagnosis(guard.value.orgId, groupId, guard.value) });
  } catch (error) { return connectionFailure(error); }
};

export const POST: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const body = await connectionBody(context.request) as Record<string, unknown>;
    if (body.action !== 'recheck') throw new ConnectionError('action must be recheck', 400);
    const groupId = hostingGroupId(body.hosting_group_id ?? 'default');
    return privateJson({ diagnosis: await recheckCloudflareDiagnosis(guard.value, groupId, { person: true }) });
  } catch (error) { return connectionFailure(error); }
};
