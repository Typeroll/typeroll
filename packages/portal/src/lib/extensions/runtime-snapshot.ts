import {
  EXTENSION_HOST_PROTOCOL_VERSION,
  EXTENSION_RUNTIME_VERSION,
  paths,
  type ExtensionInstallation,
  type ExtensionRuntimeSnapshot,
  type PublicExtensionComponent,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { formEmbedInfo, POW_BITS } from '../forms-signing';
import { extensionBlockTypeId, provisionExtensionBlocks } from './provision';
import { resolveExtensionVersion } from './resolution';

function assetBase(extensionId: string, version: string, componentId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_.-]+/g, '-');
  return `/_assets/extensions/${safe(extensionId)}/${safe(version)}/${safe(componentId)}`;
}

export async function buildExtensionRuntimeSnapshot(
  orgId: string,
  siteId: string,
): Promise<ExtensionRuntimeSnapshot> {
  const store = getStore();
  const installations = await store.listDocs<ExtensionInstallation>(paths.extensionInstallations(orgId, siteId));
  const publicInstallations: ExtensionRuntimeSnapshot['installations'] = [];
  for (const installation of installations) {
    if (installation.status !== 'enabled') continue;
    const version = (await resolveExtensionVersion(installation)).version;
    if (!version) {
      console.warn(`Skipping Extension ${installation.extension_id}: no compatible published release is available`);
      continue;
    }
    try {
      await provisionExtensionBlocks(orgId, siteId, installation, version.manifest, true);
    } catch {
      console.warn(`Could not reconcile editor blocks for Extension ${installation.extension_id}`);
    }
    const components: PublicExtensionComponent[] = (version.manifest.frontend?.components ?? []).map((component) => {
      const base = assetBase(installation.extension_id, version.version, component.id);
      const resolvedFormBindings = Object.fromEntries(
        (installation.granted_scopes.includes('forms:submit') ? component.form_bindings ?? [] : []).map((binding) => {
          const embed = formEmbedInfo(orgId, siteId, binding.form_id);
          return [binding.id, {
            ...binding,
            submit_url: embed.submit_url,
            submit_token: embed.submit_token,
            pow_bits: embed.submit_token ? POW_BITS : 0,
          }];
        }),
      );
      return {
        ...component,
        block_type_id: extensionBlockTypeId(installation.id, component.id),
        ...(Object.keys(resolvedFormBindings).length > 0
          ? { resolved_form_bindings: resolvedFormBindings }
          : {}),
        ...(component.render_mode === 'bundled_component'
          ? {
              local_script_url: `${base}/index.js`,
              ...(('style_url' in component.entry && component.entry.style_url) ? { local_style_url: `${base}/index.css` } : {}),
            }
          : {}),
      };
    });
    publicInstallations.push({
      installation_id: installation.id,
      extension_id: installation.extension_id,
      version: version.version,
      public_config: installation.public_config,
      ...(version.manifest.api
        ? {
            api: {
              base_url: version.manifest.api.base_url,
              routes: version.manifest.api.routes,
              authentication: version.manifest.api.authentication ?? 'signed_installation',
              ...((version.manifest.api.authentication ?? 'signed_installation') === 'signed_installation'
                ? { token_url: publicExtensionTokenUrl(orgId, siteId, installation.id) }
                : {}),
            },
          }
        : {}),
      components,
    });
  }
  return {
    runtime_version: EXTENSION_RUNTIME_VERSION,
    protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
    installations: publicInstallations,
  };
}

function publicExtensionTokenUrl(orgId: string, siteId: string, installationId: string): string {
  const issuer = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  if (!issuer) throw new Error('PORTAL_PUBLIC_URL is required for a signed Extension API');
  return `${issuer}/api/extensions/public-token/${encodeURIComponent(orgId)}/${encodeURIComponent(siteId)}/${encodeURIComponent(installationId)}`;
}
