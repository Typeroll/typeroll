// Operational diagnostics for one Extension installation: status, health,
// release resolution, credential metadata (never secrets), recent audit
// events, recent lifecycle event deliveries and declared URL context.
// Shared by the portal's diagnostics link and the public API.

import {
  paths,
  type ExtensionAuditEvent,
  type ExtensionEventDelivery,
  type ExtensionInstallation,
  type InstallationCredential,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { resolveExtensionVersion } from './resolution';

export async function readExtensionDiagnostics(
  ownerOrgId: string,
  siteId: string,
  installationId: string,
): Promise<Record<string, unknown> | null> {
  const store = getStore();
  const installation = await store.getDoc<ExtensionInstallation>(paths.extensionInstallation(ownerOrgId, siteId, installationId));
  if (!installation) return null;
  const resolution = await resolveExtensionVersion(installation);
  const [credentials, audit, deliveries] = await Promise.all([
    store.listDocs<InstallationCredential>(paths.extensionCredentials(ownerOrgId, siteId, installation.id)),
    store.listDocs<ExtensionAuditEvent>(paths.extensionAudit(ownerOrgId, siteId)),
    store.listDocs<ExtensionEventDelivery>(paths.extensionEventDeliveries(ownerOrgId, siteId)),
  ]);
  return {
    status: installation.status,
    health: installation.last_health_status ?? 'unknown',
    last_health_at: installation.last_health_at,
    initial_version: resolution.initial_version,
    current_version: resolution.resolved_version,
    release_resolution: resolution.reason ?? 'resolved',
    pending_activation_version: resolution.pending_activation_version,
    pending_activation_manifest: resolution.pending_activation_manifest,
    credentials: credentials.map(({ secret_hash: _hash, ...credential }) => credential),
    audit: audit.filter((event) => event.installation_id === installation.id).slice(-50),
    event_deliveries: deliveries.filter((delivery) => delivery.installation_id === installation.id).slice(-50),
    url_context: resolution.version?.manifest.frontend?.components.map((component) => ({
      component_id: component.id,
      inputs: [
        ...(component.url_context?.query ?? []).map((input) => ({ name: input.expose_as ?? input.name, source: 'query', sensitive: Boolean(input.sensitive) })),
        ...(component.url_context?.fragment ?? []).map((input) => ({ name: input.expose_as ?? input.name, source: 'fragment', sensitive: Boolean(input.sensitive) })),
      ],
    })) ?? [],
  };
}
