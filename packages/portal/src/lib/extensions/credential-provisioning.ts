import crypto from 'node:crypto';
import { paths, type ExtensionInstallation } from '@typeroll/shared';
import { getStore } from '../datastore';
import { createSafeFetch } from '../net/safe-fetch';
import {
  extensionIssuer,
  issueInstallationCredential,
  retireOtherInstallationCredentials,
  revokeInstallationCredential,
  signCredentialProvisioningAssertion,
} from './auth';
import { assertPublicDestination, parsePublicHttpsUrl } from './public-http';
import { ExtensionRegistryError, recordExtensionAudit } from './registry';
import { resolveExtensionVersion } from './resolution';

// Connects only to the address it validated, never follows a redirect and bounds the reply.
const provisioningFetch = createSafeFetch({ label: 'Extension provisioning URL', maxRedirects: 0, timeoutMs: 15_000, maxBytes: 64 * 1024 });

export interface CredentialProvisioningResult {
  status: 'connected' | 'failed';
  credential_prefix?: string;
  error?: string;
}

/**
 * Connect an installation to its provider without anyone handling the secret:
 * mint a new service credential and deliver it to the manifest's
 * `auth.provisioning_url` with a host-signed assertion. The previous
 * credentials keep working for the grace period only once the provider has
 * confirmed; a refused delivery revokes the new credential and leaves the
 * existing connection as it was.
 */
export async function provisionInstallationCredential(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  actorId: string;
  graceSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{ credential_prefix: string }> {
  const stored = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId));
  if (!stored || stored.status === 'revoked') throw new ExtensionRegistryError('Installation not found', 404);
  const installation = { ...stored, id: args.installationId };
  if (installation.status !== 'enabled') throw new ExtensionRegistryError('Enable the Extension before connecting it', 409);
  const version = (await resolveExtensionVersion(installation)).version;
  const raw = version?.manifest.auth?.provisioning_url;
  if (!version || !raw) throw new ExtensionRegistryError('Extension does not declare a credential provisioning endpoint', 409);
  let url: URL;
  try {
    url = parsePublicHttpsUrl(raw, 'Extension provisioning URL');
    await assertPublicDestination(url);
  } catch (error) {
    throw new ExtensionRegistryError((error as Error).message || 'Extension provisioning URL is not reachable', 502);
  }

  const issued = await issueInstallationCredential({ installation, now: args.now });
  const fail = async (reason: string, status = 502): Promise<never> => {
    await revokeInstallationCredential(installation, issued.id);
    await recordExtensionAudit({
      ownerOrgId: args.ownerOrgId, siteId: args.siteId, extensionId: installation.extension_id, installationId: installation.id,
      action: 'extension.credential_provisioning_failed', actorId: args.actorId, metadata: { reason },
    });
    throw new ExtensionRegistryError(`The Extension provider did not accept the connection: ${reason}`, status);
  };

  const body = {
    protocol_version: 1,
    issuer: extensionIssuer(),
    extension_id: installation.extension_id,
    version: version.version,
    org_id: installation.owner_org_id,
    site_id: installation.site_id,
    installation_id: installation.id,
    scopes: installation.granted_scopes,
    credential: issued.credential,
    assertion: signCredentialProvisioningAssertion({
      installation,
      version: version.version,
      credentialSha256: crypto.createHash('sha256').update(issued.credential).digest('hex'),
      now: args.now,
    }),
  };
  let response: Response;
  try {
    response = await (args.fetchImpl ?? provisioningFetch)(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Typeroll-Extension-Provisioning/1.0' },
      body: JSON.stringify(body),
    });
  } catch {
    return fail('the provisioning endpoint is unavailable');
  }
  if (response.status >= 300 && response.status < 400) return fail('redirects are not allowed');
  const answer = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || answer?.bound !== true) {
    const said = typeof answer?.error === 'string' ? answer.error.slice(0, 200) : `HTTP ${response.status}`;
    return fail(said);
  }

  await retireOtherInstallationCredentials({ installation, keepId: issued.id, graceSeconds: args.graceSeconds, now: args.now });
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId, siteId: args.siteId, extensionId: installation.extension_id, installationId: installation.id,
    action: 'extension.credential_provisioned', actorId: args.actorId, metadata: { credential_prefix: issued.prefix, version: version.version },
  });
  await (await import('./events')).notifyExtensionLifecycle({ installation, eventType: 'extension.credential_rotated' });
  return { credential_prefix: issued.prefix };
}

/** The same, reported instead of thrown, for flows that must not fail on it (installing). */
export async function tryProvisionInstallationCredential(args: Parameters<typeof provisionInstallationCredential>[0]): Promise<CredentialProvisioningResult> {
  try {
    const result = await provisionInstallationCredential(args);
    return { status: 'connected', ...result };
  } catch (error) {
    return { status: 'failed', error: error instanceof ExtensionRegistryError ? error.message : 'Connecting the Extension failed' };
  }
}
