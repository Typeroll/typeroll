import type { APIRoute } from 'astro';
import {
  paths,
  type ExtensionInstallation,
  type ExtensionScope,
  type ExtensionVersion,
  type TrustedExtensionIssuer,
} from '@typeroll/shared';
import { json, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { maskExtensionConfig } from '../../../../../lib/extensions/config';
import { ExtensionRegistryError, installExtension } from '../../../../../lib/extensions/registry';
import { extensionBlockTypeId } from '../../../../../lib/extensions/provision';
import { extensionIssuer } from '../../../../../lib/extensions/auth';
import { trustedExtensionIssuerId } from '../../../../../lib/extensions/trust-pairing';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const { owner_org_id, site } = guard.value;
  const installations = await getStore().listDocs<ExtensionInstallation>(paths.extensionInstallations(owner_org_id, site.id));
  const safe = await Promise.all(installations.map(async (installation) => {
    const version = await getStore().getDoc<ExtensionVersion>(
      paths.extensionVersion(installation.developer_org_id, installation.extension_id, installation.version),
    );
    let issuerTrust: Pick<TrustedExtensionIssuer, 'status' | 'paired_at'> | null = null;
    if (version?.manifest.auth?.pairing_url) {
      let issuer: string | null = null;
      try {
        issuer = extensionIssuer();
      } catch {
        // A partially configured self-hosted instance can still manage the
        // installation; the pairing action explains the missing issuer URL.
      }
      if (issuer) {
        const trusted = await getStore().getDoc<TrustedExtensionIssuer>(
          paths.trustedExtensionIssuer(
            installation.developer_org_id,
            installation.extension_id,
            trustedExtensionIssuerId(issuer),
          ),
        );
        if (trusted) issuerTrust = { status: trusted.status, paired_at: trusted.paired_at };
      }
    }
    return {
      ...installation,
      private_config: undefined,
      secret_config_enc: undefined,
      config: maskExtensionConfig(version?.manifest.config_schema, installation),
      manifest: version?.manifest,
      components: (version?.manifest.frontend?.components ?? []).map((component) => ({
        id: component.id,
        label: component.label,
        block_type_id: extensionBlockTypeId(installation.id, component.id),
      })),
      issuer_trust: issuerTrust,
      version_status: version?.status ?? 'missing',
    };
  }));
  return json({ extensions: safe });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  try {
    const installation = await installExtension({
      developerOrgId: String(body.developer_org_id ?? guard.value.owner_org_id),
      ownerOrgId: guard.value.owner_org_id,
      siteId: guard.value.site.id,
      actorId: guard.value.session.userId,
      extensionId: String(body.extension_id ?? ''),
      version: String(body.version ?? ''),
      grantedScopes: Array.isArray(body.granted_scopes) ? body.granted_scopes.map(String) as ExtensionScope[] : [],
      config: body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? body.config as Record<string, unknown>
        : {},
    });
    return json({ installation: { ...installation, private_config: undefined, secret_config_enc: undefined } }, 201);
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to install Extension' }, 500);
  }
};
