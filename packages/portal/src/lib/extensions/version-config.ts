import { type ExtensionInstallation, type ExtensionObjectSchema } from '@typeroll/shared';
import { vstore } from '../version-store';
import { resolveRequestedVersion } from '../access';
import { buildExtensionConfig } from './config';

/** Resolve only schema-declared public fields. Never accept private data from settings. */
export async function versionedExtensionInstallation(
  installation: ExtensionInstallation,
  schema: ExtensionObjectSchema | undefined,
  versionId = 'main',
): Promise<ExtensionInstallation> {
  const settings = await vstore.settings(installation.owner_org_id, installation.site_id, versionId);
  const override = settings?.extension_public_config?.[installation.id];
  if (!override) return installation;
  const incoming = Object.fromEntries(Object.entries(override).filter(([key]) => {
    const property = Object.hasOwn(schema?.properties ?? {}, key) ? schema?.properties?.[key] : undefined;
    return property?.public === true && property.format !== 'secret';
  }));
  const config = buildExtensionConfig(schema, incoming, installation);
  if (typeof config === 'string') throw new Error(`Invalid versioned Extension configuration: ${config}`);
  return { ...installation, public_config: config.public_config };
}

export async function saveExtensionPublicConfig(
  installation: ExtensionInstallation,
  schema: ExtensionObjectSchema | undefined,
  incoming: Record<string, unknown>,
  versionId: string,
): Promise<ExtensionInstallation> {
  if (!(await resolveRequestedVersion(installation.owner_org_id, installation.site_id, versionId)).ok) {
    throw new Error('Unknown site version');
  }
  for (const key of Object.keys(incoming)) {
    const property = Object.hasOwn(schema?.properties ?? {}, key) ? schema?.properties?.[key] : undefined;
    if (property?.public !== true || property.format === 'secret') {
      throw new Error(`${key} is not a public versioned configuration field. Manage credentials and private settings on main.`);
    }
  }
  const current = await versionedExtensionInstallation(installation, schema, versionId);
  const config = buildExtensionConfig(schema, incoming, current);
  if (typeof config === 'string') throw new Error(config);
  const settings = await vstore.settings(installation.owner_org_id, installation.site_id, versionId);
  await vstore.writeSettings(installation.owner_org_id, installation.site_id, versionId, {
    extension_public_config: { ...settings?.extension_public_config, [installation.id]: config.public_config },
  });
  return { ...current, public_config: config.public_config };
}
