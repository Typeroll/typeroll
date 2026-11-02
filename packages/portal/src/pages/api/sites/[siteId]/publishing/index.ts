import type { APIRoute } from 'astro';
import { requireSiteAccess } from '../../../../../lib/access';
import { privateJson } from '../../../../../lib/publishing/http';
import { publishingReadiness } from '../../../../../lib/publishing/readiness';
import { publicationTargets } from '../../../../../lib/publishing/publication-targets';

export const GET: APIRoute = async context => {
  const guard = await requireSiteAccess(context.cookies, context.params.siteId, context.locals);
  if (!guard.ok) return guard.response;
  const { owner_org_id, site, versionId } = guard.value;
  // Publish controls name the live domains in their confirmation before sending confirm_live_domains.
  const [readiness, targets] = await Promise.all([publishingReadiness(owner_org_id, site.id, versionId), publicationTargets(owner_org_id, site.id, versionId)]);
  return privateJson({ ...readiness, publication: targets });
};
