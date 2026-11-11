import {
  EXTENSION_MANIFEST_SCHEMA_VERSION,
  EXTENSION_RUNTIME_VERSION,
  isRuntimeCompatible,
  paths,
  type ExtensionInstallation,
  type ExtensionVersion,
} from '@typeroll/shared';
import { getStore } from '../datastore';
import { buildExtensionConfig } from './config';
import { isTrustedAppDeveloper } from './trusted-developers';

export interface ExtensionVersionResolution {
  version: ExtensionVersion | null;
  initial_version: string;
  resolved_version?: string;
  automatically_updated: boolean;
  pending_activation_version?: string;
  pending_activation_manifest?: ExtensionVersion['manifest'];
  reason?: 'no_compatible_release';
}

function parseSemver(value: string): [number, number, number, string] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
    : null;
}

function compareVersions(left: ExtensionVersion, right: ExtensionVersion): number {
  const a = parseSemver(left.version);
  const b = parseSemver(right.version);
  if (!a || !b) return left.version.localeCompare(right.version);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number);
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

export function requiresExplicitActivation(installation: ExtensionInstallation, target: ExtensionVersion, versions: ExtensionVersion[]): boolean {
  // Within a contract every release is automatic; another contract is always explicit.
  if (target.manifest.contract !== installation.contract) return true;
  if (installation.contract !== undefined) return false;
  const selected = { version: installation.version } as ExtensionVersion;
  return versions.some(release => release.manifest.contract === undefined && ['published', 'deprecated', 'revoked'].includes(release.status) &&
    release.manifest.activation_policy === 'explicit' && compareVersions(release, selected) > 0 && compareVersions(release, target) <= 0);
}

export function isForwardRelease(current: string, next: string): boolean {
  return compareVersions({ version: next } as ExtensionVersion, { version: current } as ExtensionVersion) > 0;
}

function canRunVersion(
  installation: ExtensionInstallation,
  version: ExtensionVersion,
): boolean {
  if (version.extension_id !== installation.extension_id ||
    version.version !== version.manifest.version ||
    version.manifest.id !== installation.extension_id ||
    version.schema_version !== EXTENSION_MANIFEST_SCHEMA_VERSION ||
    version.manifest.schema_version !== EXTENSION_MANIFEST_SCHEMA_VERSION ||
    !isRuntimeCompatible(version.compatibility, EXTENSION_RUNTIME_VERSION) ||
    !isRuntimeCompatible(version.manifest.runtime_compatibility, EXTENSION_RUNTIME_VERSION)) {
    return false;
  }
  // A contract release runs only for a trusted developer, also after one is removed from the list.
  if (version.manifest.contract !== undefined && !isTrustedAppDeveloper(installation.developer_org_id)) return false;
  return typeof buildExtensionConfig(version.manifest.config_schema, {}, installation) !== 'string';
}

/**
 * Resolves a timeless installation to the newest release it can run without
 * changing its administrator-approved scopes or stored configuration.
 */
export async function resolveExtensionVersion(
  installation: ExtensionInstallation,
): Promise<ExtensionVersionResolution> {
  const versions = await getStore().listDocs<ExtensionVersion>(
    paths.extensionVersions(installation.developer_org_id, installation.extension_id),
  );
  const developerPreview = installation.developer_org_id === installation.owner_org_id;
  const candidates = versions.filter((version) => {
    const released = version.status === 'published' || version.status === 'deprecated';
    const selectedPreview = developerPreview && version.version === installation.version &&
      (version.status === 'draft' || version.status === 'review');
    return (released || selectedPreview) && !requiresExplicitActivation(installation, version, versions) && canRunVersion(installation, version);
  });
  const version = candidates.sort(compareVersions).at(-1) ?? null;
  // A newer contract (or the first one, for an installation without) waits for an explicit activation.
  const pending = versions.filter(release => release.status === 'published' &&
    requiresExplicitActivation(installation, release, versions) &&
    (release.manifest.contract === undefined ? installation.contract === undefined
      : release.manifest.contract > (installation.contract ?? 0) && isTrustedAppDeveloper(installation.developer_org_id)) &&
    isRuntimeCompatible(release.manifest.runtime_compatibility, EXTENSION_RUNTIME_VERSION)).sort(compareVersions).at(-1);
  const initialVersion = installation.initial_version ?? installation.version;
  return {
    version,
    initial_version: initialVersion,
    ...(version ? { resolved_version: version.version } : {}),
    automatically_updated: Boolean(version && version.version !== installation.version),
    ...(pending ? { pending_activation_version: pending.version, pending_activation_manifest: pending.manifest } : {}),
    ...(!version ? { reason: 'no_compatible_release' as const } : {}),
  };
}
