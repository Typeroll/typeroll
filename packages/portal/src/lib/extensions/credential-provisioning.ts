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
  // Cleanup must never hide why the connection failed.
  const fail = async (reason: string, status = 502): Promise<never> => {
    await revokeInstallationCredential(installation, issued.id).catch((error) => logFailure(installation, 'revoke', error));
    await recordExtensionAudit({
      ownerOrgId: args.ownerOrgId, siteId: args.siteId, extensionId: installation.extension_id, installationId: installation.id,
      action: 'extension.credential_provisioning_failed', actorId: args.actorId, metadata: { reason },
    }).catch((error) => logFailure(installation, 'audit', error));
    throw new ExtensionRegistryError(`The Extension provider did not accept the connection: ${reason}`, status);
  };

  let body: Record<string, unknown>;
  try {
    body = {
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
  } catch (error) {
    logFailure(installation, 'sign', error);
    return fail(`signing the assertion failed: ${messageOf(error)}`, 500);
  }
  let response: Response;
  try {
    response = await (args.fetchImpl ?? provisioningFetch)(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Typeroll-Extension-Provisioning/1.0' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    logFailure(installation, 'deliver', error);
    return fail(`the provisioning endpoint is unavailable (${messageOf(error)})`);
  }
  if (response.status >= 300 && response.status < 400) return fail('redirects are not allowed');
  const answer = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || answer?.bound !== true) {
    const said = typeof answer?.error === 'string' ? answer.error.slice(0, 200) : `HTTP ${response.status}`;
    return fail(said);
  }

  // The provider holds the new credential now; what follows must not turn that into a failure.
  await retireOtherInstallationCredentials({ installation, keepId: issued.id, graceSeconds: args.graceSeconds, now: args.now })
    .catch((error) => logFailure(installation, 'retire', error));
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId, siteId: args.siteId, extensionId: installation.extension_id, installationId: installation.id,
    action: 'extension.credential_provisioned', actorId: args.actorId, metadata: { credential_prefix: issued.prefix, version: version.version },
  }).catch((error) => logFailure(installation, 'audit', error));
  await (await import('./events')).notifyExtensionLifecycle({ installation, eventType: 'extension.credential_rotated' })
    .catch((error) => logFailure(installation, 'event', error));
  return { credential_prefix: issued.prefix };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** One structured line per failure; never the credential, which no error message contains. */
function logFailure(installation: ExtensionInstallation, stage: string, error: unknown): void {
  console.error(JSON.stringify({ event: 'extension_credential_provisioning_failed', installation_id: installation.id, extension_id: installation.extension_id, stage, error: messageOf(error) }));
}

/** The same, reported instead of thrown, for flows that must not fail on it (installing). */
export async function tryProvisionInstallationCredential(args: Parameters<typeof provisionInstallationCredential>[0]): Promise<CredentialProvisioningResult> {
  try {
    const result = await provisionInstallationCredential(args);
    return { status: 'connected', ...result };
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return { status: 'failed', error: error.message };
    console.error(JSON.stringify({ event: 'extension_credential_provisioning_failed', installation_id: args.installationId, stage: 'unexpected', error: messageOf(error) }));
    return { status: 'failed', error: `Connecting the Extension failed: ${messageOf(error)}` };
  }
}
