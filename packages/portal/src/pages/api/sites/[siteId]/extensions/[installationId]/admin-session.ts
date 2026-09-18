import type { APIRoute } from 'astro';
import { effectiveExtensionScopes, paths, type ExtensionInstallation } from '@typeroll/shared';
import { json, requirePermission, requireSiteAccess } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { signDelegatedExtensionToken, extensionIssuer } from '../../../../../../lib/extensions/auth';
import { approvedNativeAdmin } from '../../../../../../lib/extensions/native-admin';
import { resolveExtensionVersion } from '../../../../../../lib/extensions/resolution';

export const POST: APIRoute = async ({ cookies, params, locals, request }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const body = await request.json().catch(() => null);
  if (typeof body?.page_id !== 'string' || !params.installationId) return json({ error: 'Page and installation are required' }, 400);
  const { owner_org_id: orgId, site, session, permission } = guard.value;
  const installation = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(orgId, site.id, params.installationId));
  if (!installation || installation.status !== 'enabled') return json({ error: 'App unavailable' }, 404);
  const version = (await resolveExtensionVersion(installation)).version;
  const page = version?.manifest.admin?.pages.find(p => p.id === body.page_id);
  if (!page?.native || !version || !await approvedNativeAdmin(installation, version)) return json({ error: 'This app release is not approved for portal integration' }, 403);
  const allowed = requirePermission(guard.value, page.minimum_permission);
  if (!allowed.ok) return allowed.response;
  const signed = signDelegatedExtensionToken({
    token_use: 'portal_admin', page_id: page.id, version: version.version,
    aud: installation.extension_id, sub: session.userId, org_id: orgId, site_id: site.id,
    installation_id: installation.id, permission, scopes: effectiveExtensionScopes(installation.granted_scopes, permission),
  });
  const response = json({ token: signed.token, expires_at: signed.claims.exp * 1000,
    issuer: extensionIssuer(), org_id: orgId, site_id: site.id, installation_id: installation.id,
    version: version.version, permission, native: page.native });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
