import type { APIRoute } from 'astro';
import { analyticsChanges, readAnalyticsOverview, setOrganizationAnalytics } from '../../../lib/apps/analytics-overview';
import { connectionBody, connectionFailure, privateJson, publishingAdmin } from '../../../lib/publishing/http';

// The portal's Organization Analytics overview (owners and admins). The same
// state is served to organization API keys by /api/v1/organization/analytics.
export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson(await readAnalyticsOverview(guard.value.orgId)); }
  catch (error) { return connectionFailure(error); }
};

export const POST: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const results = await setOrganizationAnalytics(guard.value.orgId, analyticsChanges(await connectionBody(context.request)));
    return privateJson({ results });
  } catch (error) { return connectionFailure(error); }
};
