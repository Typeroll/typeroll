// Finding the apps that derive published data, and calling them.
//
// The transport half of build-derivation.ts. Kept separate so the contract —
// what a valid result is, what may be reused — stays testable without a
// network, an installation or a signing key.
//
// Nothing here is proxied through Typeroll at request time: the provider owns
// its API, Core calls it once per publication with a short-lived proof, and the
// answer is frozen into the artifact. A visitor never reaches the provider for
// derived data, which is the point — published output must not depend on an
// app being up.

import { randomUUID } from 'node:crypto';
import type { ExtensionInstallation, ExtensionRuntimeSnapshot } from '@typeroll/shared';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { signInstallationAssertion } from '../extensions/auth';
import { adminDestination, requestApprovedAdmin } from '../extensions/admin-request';
import { resolveExtensionVersion } from '../extensions/resolution';
import {
  DerivationError,
  stableDigest,
  type DerivationInput,
  type DerivationProvider,
} from './build-derivation';

/**
 * Content this publication derives from, as one digest.
 *
 * Deliberately the resolved publication content and nothing else. Media,
 * domains and the site URL do not change what a company's accepted answers
 * are, and including them would invalidate every derivation on a domain
 * change — a rebuild that cannot possibly alter derived data.
 */
export function publicationContentDigest(resolved: {
  versionId: string;
  pages?: unknown;
  contentTypes?: unknown;
  blockTypes?: unknown;
  pageTemplates?: unknown;
  settings?: unknown;
}): string {
  return stableDigest({
    version: resolved.versionId,
    pages: resolved.pages ?? null,
    content_types: resolved.contentTypes ?? null,
    block_types: resolved.blockTypes ?? null,
    page_templates: resolved.pageTemplates ?? null,
    settings: resolved.settings ?? null,
  });
}

/** Public app and installation configuration in force for this publication. */
export function publicationConfigDigest(runtime: {
  apps?: unknown;
  extensions?: { installations?: Array<{ extension_id: string; version?: string; public_config?: unknown }> };
}): string {
  return stableDigest({
    apps: runtime.apps ?? null,
    installations: (runtime.extensions?.installations ?? [])
      .map((installation) => ({
        id: installation.extension_id,
        version: installation.version ?? null,
        config: installation.public_config ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  });
}

/**
 * The apps on this site that declared a build derivation.
 *
 * Reads the runtime snapshot rather than the installation documents, so an
 * app resolved to a newer release derives with that release — the same
 * resolution the published page would use. Deriving with one version while
 * rendering with another is the kind of mismatch that produces output nobody
 * can reproduce.
 */
export async function derivationProvidersFor(
  orgId: string,
  siteId: string,
  snapshot: Pick<ExtensionRuntimeSnapshot, 'installations'>,
): Promise<DerivationProvider[]> {
  const store = getStore();
  const providers: DerivationProvider[] = [];
  const claimed = new Map<string, string>();

  for (const runtimeInstallation of snapshot.installations) {
    const installation = await store.getDoc<ExtensionInstallation>(
      paths.extensionInstallation(orgId, siteId, runtimeInstallation.installation_id),
    );
    if (!installation || installation.status !== 'enabled') continue;
    const resolution = await resolveExtensionVersion(installation);
    const manifest = resolution.version?.manifest;
    const derivation = manifest?.build_derivation;
    if (!derivation || !manifest?.api?.base_url) continue;

    // Declared collisions are refused here, before a build starts, so the
    // failure names two apps rather than appearing as missing data later.
    for (const source of derivation.sources ?? []) {
      const owner = claimed.get(source);
      if (owner) {
        throw new DerivationError(
          `Derived source ${source} is claimed by both ${owner} and ${manifest.id}`,
          manifest.id,
        );
      }
      claimed.set(source, manifest.id);
    }

    const base = manifest.api.base_url;
    const path = derivation.path;
    const version = manifest.version;
    providers.push({
      id: installation.id,
      version,
      required: derivation.required === true,
      request: async (input: DerivationInput) => {
        const url = adminDestination(base, { page_id: 'build', path, method: 'POST', body: input });
        const token = signInstallationAssertion({
          installation,
          scopes: [],
          correlationId: randomUUID(),
          purpose: 'build_derivation',
          version,
        });
        const { status, data } = await requestApprovedAdmin(
          url,
          { page_id: 'build', path, method: 'POST', body: input },
          token,
          // The issuer, not a site origin: this is a server-to-server call
          // made once per publication, not a browser request.
          new URL(base).origin,
        );
        if (status !== 200) {
          throw new DerivationError(`Derivation provider answered ${status}`, installation.id);
        }
        return data;
      },
    });
  }
  return providers;
}
