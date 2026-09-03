import { Buffer } from 'node:buffer';
import {
  buildExtensionRuntimeScript,
  paths,
  type ExtensionInstallation,
  type ExtensionRuntimeHostConfig,
  type ExtensionRuntimeSnapshot,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import {
  assertExtensionAssetDigest,
  MAX_EXTENSION_SCRIPT_BYTES,
  MAX_EXTENSION_STYLE_BYTES,
} from './assets';
import { signPublicExtensionToken } from './auth';
import { fetchPublicAsset } from './public-http';
import { buildExtensionRuntimeSnapshot } from './runtime-snapshot';

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * Convert a deploy-capable runtime snapshot into a side-effect-safe preview.
 * Provider API access is opt-in per method, and Forms bindings keep their
 * identity for faithful rendering while losing every submit capability.
 */
export function prepareExtensionPreviewSnapshot(
  input: ExtensionRuntimeSnapshot,
): ExtensionRuntimeSnapshot {
  return {
    ...input,
    installations: input.installations.map((installation) => ({
      ...installation,
      preview: true,
      ...(installation.api
        ? {
            api: {
              ...installation.api,
              token_url: undefined,
              preview_token: undefined,
              routes: installation.api.routes.flatMap((route) => {
                if (!route.preview_methods?.length) return [];
                const { preview_methods, ...rest } = route;
                return [{ ...rest, methods: preview_methods }];
              }),
            },
          }
        : {}),
      components: installation.components.map((component) => ({
        ...component,
        ...(component.resolved_form_bindings
          ? {
              resolved_form_bindings: Object.fromEntries(
                Object.entries(component.resolved_form_bindings).map(([id, binding]) => [
                  id,
                  { ...binding, submit_token: null, pow_bits: 0 },
                ]),
              ),
            }
          : {}),
      })),
    })),
  };
}

/**
 * Build the public metadata shared by every isolated preview host. The same
 * short-lived proof and preview-only route projection must reach both the
 * standalone preview runtime and the editor's nested Extension frame.
 */
export async function buildExtensionPreviewSnapshot(
  orgId: string,
  siteId: string,
): Promise<ExtensionRuntimeSnapshot> {
  const snapshot = prepareExtensionPreviewSnapshot(
    await buildExtensionRuntimeSnapshot(orgId, siteId),
  );
  const installationDocs = await getStore().listDocs<ExtensionInstallation>(
    paths.extensionInstallations(orgId, siteId),
  );
  const byId = new Map(installationDocs.map((installation) => [installation.id, installation]));

  for (const installation of snapshot.installations) {
    if (installation.api?.authentication !== 'signed_installation' || installation.api.routes.length === 0) continue;
    const doc = byId.get(installation.installation_id);
    if (!doc) continue;
    installation.api = {
      ...installation.api,
      token_url: undefined,
      preview_token: signPublicExtensionToken({
        installation: doc,
        origin: 'null',
        previewRoutes: installation.api.routes,
      }).token,
    };
  }

  return snapshot;
}

/**
 * Build the public Extension host for a DB-live preview.
 *
 * A preview has no deployed `/_assets/extensions/*` tree, so verified bundle
 * bytes are embedded as data URLs. The preview response is sandboxed without
 * `allow-same-origin`; its network Origin is therefore `null`. API proofs are
 * minted for exactly that opaque origin and expire after five minutes.
 */
export async function buildExtensionPreviewRuntimeScript(
  orgId: string,
  siteId: string,
  hostConfig: ExtensionRuntimeHostConfig = {},
): Promise<string> {
  const snapshot = await buildExtensionPreviewSnapshot(orgId, siteId);
  if (!snapshot.installations.length) return '';

  for (const installation of snapshot.installations) {
    for (const component of installation.components) {
      if (component.render_mode !== 'bundled_component') continue;
      const entry = component.entry as {
        script_url: string;
        script_sha256: string;
        style_url?: string;
        style_sha256?: string;
      };
      try {
        const script = await fetchPublicAsset(entry.script_url, MAX_EXTENSION_SCRIPT_BYTES);
        assertExtensionAssetDigest(script, entry.script_sha256, `${component.id} script`);
        component.local_script_url = dataUrl('text/javascript', script);
        if (entry.style_url) {
          const style = await fetchPublicAsset(entry.style_url, MAX_EXTENSION_STYLE_BYTES);
          assertExtensionAssetDigest(style, String(entry.style_sha256 ?? ''), `${component.id} style`);
          component.local_style_url = dataUrl('text/css', style);
        }
      } catch {
        // Keep preview failure inert and component-local. The public runtime
        // catches this module error and renders the manifest's unavailable
        // message without hiding other instances on the page.
        component.local_script_url = dataUrl(
          'text/javascript',
          Buffer.from('throw new Error("Extension preview asset unavailable")'),
        );
        component.local_style_url = undefined;
      }
    }
  }

  return buildExtensionRuntimeScript(snapshot, hostConfig);
}
