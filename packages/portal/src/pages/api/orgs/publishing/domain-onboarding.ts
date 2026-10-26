import type { APIRoute } from 'astro';
import { publishingAdmin, connectionBody, privateJson, connectionFailure } from '../../../../lib/publishing/http';
import { onboardDomainZone } from '../../../../lib/publishing/domain-zone-onboarding';
export const POST: APIRoute = async context => {
  const guard = await publishingAdmin(context); if (!guard.ok) return guard.response;
  try {
    const input = await connectionBody(context.request) as Record<string, unknown>;
    if (typeof input.site_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.site_id)) return privateJson({ error: 'Select a site owned by this organization.' }, 400);
    return privateJson(await onboardDomainZone(guard.value.orgId, input.site_id, input));
  } catch (error) { return connectionFailure(error); }
};
