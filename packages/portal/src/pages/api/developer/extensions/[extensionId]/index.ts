import type { APIRoute } from 'astro';
import { paths, type Extension, type ExtensionVersion } from '@typeroll/shared';
import { json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import {
  claimExtensionIdReservation,
  ExtensionRegistryError,
  normalizeExtensionTrustedOrigins,
  readExtensionIdReservation,
  updateExtensionDistribution,
} from '../../../../../lib/extensions/registry';
import { requireDeveloperAccess } from '../../../../../lib/extensions/developer-access';
import { parseAllowedSiteIds } from '../../../../../lib/extensions/allowed-site-ids';

async function guard(request: Request, cookies: Parameters<typeof requireDeveloperAccess>[1], extensionId: string | undefined) {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access;
  if (!extensionId) return { ok: false as const, response: json({ error: 'Missing extensionId' }, 400) };
  return { ok: true as const, value: { developer: access, extensionId } };
}

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const access = await guard(request, cookies, params.extensionId);
  if (!access.ok) return access.response;
  const { developer, extensionId } = access.value;
  const extension = await getStore().getDoc<Extension>(paths.extension(developer.orgId, extensionId));
  if (!extension) return json({ error: 'Extension not found' }, 404);
  const versions = await getStore().listDocs<ExtensionVersion>(paths.extensionVersions(developer.orgId, extensionId));
  const { client_secret_hash: _secret, ...safe } = extension;
  // developer_org_id is the value of the `developer_org_id` claim in every
  // token Typeroll issues for this Extension's installations.
  return json({ extension: safe, versions, id_reservation: await readExtensionIdReservation(developer.orgId, extensionId) });
};

export const PATCH: APIRoute = async ({ request, cookies, params }) => {
  const access = await guard(request, cookies, params.extensionId);
  if (!access.ok) return access.response;
  const { developer, extensionId } = access.value;
  const path = paths.extension(developer.orgId, extensionId);
  const extension = await getStore().getDoc<Extension>(path);
  if (!extension) return json({ error: 'Extension not found' }, 404);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = String(body.name).trim();
  if (body.status === 'active' || body.status === 'suspended') update.status = body.status;
  if (Array.isArray(body.allowed_org_ids)) update.allowed_org_ids = body.allowed_org_ids.map(String);
  try {
    const allowedSiteIds = parseAllowedSiteIds(body.allowed_site_ids);
    if (allowedSiteIds) update.allowed_site_ids = allowedSiteIds;
    if (Array.isArray(body.trusted_origins)) {
      update.trusted_origins = normalizeExtensionTrustedOrigins(body.trusted_origins.map(String));
    }
    await claimExtensionIdReservation(developer.orgId, extensionId);
    let current = extension;
    if (body.distribution !== undefined) {
      current = await updateExtensionDistribution({
        developerOrgId: developer.orgId,
        extensionId,
        distribution: String(body.distribution) as Extension['distribution'],
      });
    }
    await getStore().updateDoc(path, update);
    return json({ extension: { ...current, ...update, client_secret_hash: undefined } });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    throw error;
  }
};
