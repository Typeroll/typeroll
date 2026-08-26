import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation, type ExtensionAuditEvent, type ExtensionEventDelivery, type ExtensionVersion, type InstallationCredential } from '@typeroll/shared';
import { json, requirePermission, requireSiteAccess } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  if (!params.installationId) return json({ error: 'Missing installationId' }, 400);
  const { owner_org_id, site } = guard.value;
  const installation = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(owner_org_id, site.id, params.installationId));
  if (!installation) return json({ error: 'Installation not found' }, 404);
  const [credentials, audit, deliveries] = await Promise.all([
    getStore().listDocs<InstallationCredential>(paths.extensionCredentials(owner_org_id, site.id, installation.id)),
    getStore().listDocs<ExtensionAuditEvent>(paths.extensionAudit(owner_org_id, site.id)),
    getStore().listDocs<ExtensionEventDelivery>(paths.extensionEventDeliveries(owner_org_id, site.id)),
  ]);
  return json({
    status: installation.status,
    health: installation.last_health_status ?? 'unknown',
    last_health_at: installation.last_health_at,
    credentials: credentials.map(({ secret_hash: _hash, ...credential }) => credential),
    audit: audit.filter((event) => event.installation_id === installation.id).slice(-50),
    event_deliveries: deliveries.filter((delivery) => delivery.installation_id === installation.id).slice(-50),
    url_context: (await getStore().getDoc(paths.extensionVersion(installation.developer_org_id, installation.extension_id, installation.version)) as ExtensionVersion | null)
      ?.manifest.frontend?.components.map((component) => ({
        component_id: component.id,
        inputs: [
          ...(component.url_context?.query ?? []).map((input) => ({ name: input.expose_as ?? input.name, source: 'query', sensitive: Boolean(input.sensitive) })),
          ...(component.url_context?.fragment ?? []).map((input) => ({ name: input.expose_as ?? input.name, source: 'fragment', sensitive: Boolean(input.sensitive) })),
        ],
      })) ?? [],
  });
};
