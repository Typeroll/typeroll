import crypto from 'node:crypto';
import {
  EXTENSION_RUNTIME_VERSION,
  paths,
  validateExtensionManifest,
  type ExtensionInstallation,
  type Extension,
  type ExtensionAuditEvent,
  type ExtensionCatalogEntry,
  type ExtensionManifest,
  type ExtensionScope,
  type ExtensionVersion,
} from '@typeroll/shared';
import { getStore, generateDocId } from '../datastore';
import { buildExtensionConfig } from './config';
import { provisionExtensionBlocks } from './provision';

export class ExtensionRegistryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ExtensionRegistryError';
  }
}

function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new ExtensionRegistryError(`Invalid trusted origin: ${value}`);
  }
}

export function normalizeExtensionTrustedOrigins(values: string[]): string[] {
  return [...new Set(values.map(normalizeOrigin))];
}

function manifestExecutionOrigins(manifest: ExtensionManifest): string[] {
  const urls: string[] = [];
  for (const component of manifest.frontend?.components ?? []) {
    if ('script_url' in component.entry) {
      urls.push(component.entry.script_url);
      if (component.entry.style_url) urls.push(component.entry.style_url);
    } else if ('frame_url' in component.entry) urls.push(component.entry.frame_url);
  }
  for (const page of manifest.admin?.pages ?? []) urls.push(page.launch_url);
  if (manifest.api?.base_url) urls.push(manifest.api.base_url);
  if (manifest.events?.webhook_url) urls.push(manifest.events.webhook_url);
  if (manifest.auth?.pairing_url) urls.push(manifest.auth.pairing_url);
  return [...new Set(urls.map((value) => new URL(value).origin))];
}

export async function recordExtensionAudit(args: {
  ownerOrgId: string;
  siteId: string;
  extensionId: string;
  installationId?: string;
  action: string;
  actorId?: string;
  metadata?: ExtensionAuditEvent['metadata'];
}): Promise<void> {
  await getStore().addDoc(paths.extensionAudit(args.ownerOrgId, args.siteId), {
    extension_id: args.extensionId,
    installation_id: args.installationId,
    site_id: args.siteId,
    action: args.action,
    actor_id: args.actorId,
    created_at: new Date().toISOString(),
    metadata: args.metadata,
  } satisfies Omit<ExtensionAuditEvent, 'id'>);
}

export async function createExtension(args: {
  developerOrgId: string;
  actorId: string;
  id: string;
  name: string;
  distribution?: Extension['distribution'];
  trustedOrigins?: string[];
  allowedOrgIds?: string[];
  allowedSiteIds?: string[];
}): Promise<{ extension: Extension; client_secret: string }> {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9][a-z0-9-]*){2,}$/.test(args.id)) {
    throw new ExtensionRegistryError('Extension id must be a lowercase namespaced identifier');
  }
  if (!args.name.trim()) throw new ExtensionRegistryError('Extension name is required');
  if (args.distribution && !['private', 'unlisted', 'public'].includes(args.distribution)) {
    throw new ExtensionRegistryError('Invalid Extension distribution');
  }
  const path = paths.extension(args.developerOrgId, args.id);
  if (await getStore().getDoc<Extension>(path)) throw new ExtensionRegistryError('Extension already exists', 409);
  const now = new Date().toISOString();
  const clientSecret = `tre_${randomSecret()}`;
  const extension: Extension = {
    id: args.id,
    developer_org_id: args.developerOrgId,
    name: args.name.trim(),
    distribution: args.distribution ?? 'private',
    status: 'active',
    allowed_org_ids: args.allowedOrgIds,
    allowed_site_ids: args.allowedSiteIds,
    client_id: `trc_${randomSecret(18)}`,
    client_secret_hash: sha256(clientSecret),
    trusted_origins: normalizeExtensionTrustedOrigins(args.trustedOrigins ?? []),
    created_at: now,
    updated_at: now,
  };
  const { id: _id, ...body } = extension;
  await getStore().setDoc(path, body);
  return { extension, client_secret: clientSecret };
}

export async function saveExtensionVersion(args: {
  developerOrgId: string;
  extensionId: string;
  actorId: string;
  manifest: unknown;
}): Promise<ExtensionVersion> {
  const extension = await getStore().getDoc<Extension>(paths.extension(args.developerOrgId, args.extensionId));
  if (!extension || extension.developer_org_id !== args.developerOrgId) throw new ExtensionRegistryError('Extension not found', 404);
  if (extension.status !== 'active') throw new ExtensionRegistryError('Extension is suspended', 409);
  const validation = validateExtensionManifest(args.manifest);
  if (!validation.valid || !validation.manifest) throw new ExtensionRegistryError(validation.errors.join('\n'));
  const manifest = validation.manifest;
  if (manifest.id !== args.extensionId) throw new ExtensionRegistryError('Manifest id does not match extension id');
  if (manifest.distribution !== extension.distribution) throw new ExtensionRegistryError('Manifest distribution does not match extension distribution');
  const untrustedOrigins = manifestExecutionOrigins(manifest)
    .filter((origin) => !extension.trusted_origins.includes(origin));
  if (untrustedOrigins.length) {
    throw new ExtensionRegistryError(`Manifest uses unregistered execution origins: ${untrustedOrigins.join(', ')}`);
  }
  const versionPath = paths.extensionVersion(args.developerOrgId, args.extensionId, manifest.version);
  const existing = await getStore().getDoc<ExtensionVersion>(versionPath);
  if (existing && existing.status !== 'draft') throw new ExtensionRegistryError('Published extension versions are immutable', 409);
  const now = new Date().toISOString();
  const version: ExtensionVersion = {
    id: manifest.version,
    extension_id: args.extensionId,
    version: manifest.version,
    schema_version: manifest.schema_version,
    manifest,
    manifest_sha256: sha256(canonicalJson(manifest)),
    status: 'draft',
    compatibility: manifest.runtime_compatibility,
    created_at: existing?.created_at ?? now,
    created_by: existing?.created_by ?? args.actorId,
  };
  const { id: _id, ...body } = version;
  await getStore().setDoc(versionPath, body);
  return version;
}

export async function updateExtensionDistribution(args: {
  developerOrgId: string;
  extensionId: string;
  distribution: Extension['distribution'];
}): Promise<Extension> {
  if (!['private', 'unlisted', 'public'].includes(args.distribution)) {
    throw new ExtensionRegistryError('Invalid Extension distribution');
  }
  const store = getStore();
  const extensionPath = paths.extension(args.developerOrgId, args.extensionId);
  const extension = await store.getDoc<Extension>(extensionPath);
  if (!extension || extension.developer_org_id !== args.developerOrgId) {
    throw new ExtensionRegistryError('Extension not found', 404);
  }
  const versions = await store.listDocs<ExtensionVersion>(paths.extensionVersions(args.developerOrgId, args.extensionId));
  const catalogEntry = await store.getDoc<ExtensionCatalogEntry>(paths.extensionCatalogEntry(args.extensionId));
  if (versions.some((version) => version.status !== 'draft') || catalogEntry?.developer_org_id === args.developerOrgId) {
    throw new ExtensionRegistryError('Extension distribution cannot change after a version has left draft', 409);
  }
  const now = new Date().toISOString();
  const previousDistribution = extension.distribution;
  const rewritten: ExtensionVersion[] = [];
  await store.updateDoc(extensionPath, { distribution: args.distribution, updated_at: now });
  try {
    for (const listedVersion of versions) {
      const versionPath = paths.extensionVersion(args.developerOrgId, args.extensionId, listedVersion.version);
      const current = await store.getDoc<ExtensionVersion>(versionPath);
      if (!current || current.status !== 'draft') {
        throw new ExtensionRegistryError('Extension distribution changed concurrently with version publication', 409);
      }
      const manifest: ExtensionManifest = { ...current.manifest, distribution: args.distribution };
      const next: ExtensionVersion = {
        ...current,
        manifest,
        manifest_sha256: sha256(canonicalJson(manifest)),
      };
      const { id: _id, ...body } = next;
      await store.setDoc(versionPath, body);
      rewritten.push(current);
    }
  } catch (error) {
    await store.updateDoc(extensionPath, { distribution: previousDistribution, updated_at: new Date().toISOString() });
    for (const previous of rewritten) {
      const { id: _id, ...body } = previous;
      await store.setDoc(paths.extensionVersion(args.developerOrgId, args.extensionId, previous.version), body);
    }
    throw error;
  }
  return { ...extension, distribution: args.distribution, updated_at: now };
}

export async function publishExtensionVersion(args: {
  developerOrgId: string;
  extensionId: string;
  version: string;
  verifyAssets: (manifest: ExtensionManifest) => Promise<void>;
}): Promise<ExtensionVersion> {
  const versionPath = paths.extensionVersion(args.developerOrgId, args.extensionId, args.version);
  const current = await getStore().getDoc<ExtensionVersion>(versionPath);
  if (!current) throw new ExtensionRegistryError('Extension version not found', 404);
  const extension = await getStore().getDoc<Extension>(paths.extension(args.developerOrgId, args.extensionId));
  if (!extension || extension.distribution !== current.manifest.distribution) {
    throw new ExtensionRegistryError('Extension distribution does not match the saved manifest', 409);
  }
  if (current.status === 'published' || current.status === 'review') return current;
  if (current.status !== 'draft') throw new ExtensionRegistryError('Extension version cannot be published from its current state', 409);
  await args.verifyAssets(current.manifest);
  const now = new Date().toISOString();
  const requiresReview = current.manifest.distribution === 'public';
  if (requiresReview) {
    const existingCatalog = await getStore().getDoc<ExtensionCatalogEntry>(paths.extensionCatalogEntry(current.extension_id));
    if (existingCatalog && existingCatalog.developer_org_id !== args.developerOrgId) {
      throw new ExtensionRegistryError('This public Extension id is owned by another developer organization', 409);
    }
  }
  const published: ExtensionVersion = {
    ...current,
    status: requiresReview ? 'review' : 'published',
    published_at: requiresReview ? undefined : now,
  };
  const { id: _id, ...body } = published;
  await getStore().setDoc(versionPath, body);
  if (requiresReview) {
    const catalog: ExtensionCatalogEntry = {
      id: current.extension_id,
      extension_id: current.extension_id,
      developer_org_id: args.developerOrgId,
      version: current.version,
      name: current.manifest.name,
      developer_name: current.manifest.developer.name,
      description: current.manifest.frontend?.components[0]?.description,
      icon: current.manifest.frontend?.components[0]?.icon,
      support_url: current.manifest.developer.support_url,
      privacy_url: current.manifest.developer.privacy_url,
      permissions: current.manifest.permissions,
      data_handling: current.manifest.data_handling,
      manifest_sha256: current.manifest_sha256,
      status: 'in_review',
      submitted_at: now,
    };
    const { id: _catalogId, ...catalogBody } = catalog;
    await getStore().setDoc(paths.extensionCatalogEntry(current.extension_id), catalogBody);
  }
  return published;
}

export async function reviewPublicExtension(args: {
  extensionId: string;
  approve: boolean;
  reviewerId: string;
  note?: string;
}): Promise<ExtensionCatalogEntry> {
  const store = getStore();
  const catalogPath = paths.extensionCatalogEntry(args.extensionId);
  const entry = await store.getDoc<ExtensionCatalogEntry>(catalogPath);
  if (!entry || entry.status !== 'in_review') throw new ExtensionRegistryError('Extension review not found', 404);
  const versionPath = paths.extensionVersion(entry.developer_org_id, entry.extension_id, entry.version);
  const version = await store.getDoc<ExtensionVersion>(versionPath);
  if (!version || version.status !== 'review' || version.manifest_sha256 !== entry.manifest_sha256) {
    throw new ExtensionRegistryError('Reviewed manifest no longer matches the submitted version', 409);
  }
  const now = new Date().toISOString();
  const nextEntry: ExtensionCatalogEntry = {
    ...entry,
    status: args.approve ? 'published' : 'rejected',
    reviewed_at: now,
    reviewed_by: args.reviewerId,
    review_note: args.note?.slice(0, 2000),
  };
  const { id: _id, ...entryBody } = nextEntry;
  await store.setDoc(catalogPath, entryBody);
  const nextVersion: ExtensionVersion = {
    ...version,
    status: args.approve ? 'published' : 'draft',
    published_at: args.approve ? now : undefined,
  };
  const { id: _versionId, ...versionBody } = nextVersion;
  await store.setDoc(versionPath, versionBody);
  return nextEntry;
}

export async function rotateExtensionClientSecret(args: {
  developerOrgId: string;
  extensionId: string;
}): Promise<string> {
  const path = paths.extension(args.developerOrgId, args.extensionId);
  const extension = await getStore().getDoc<Extension>(path);
  if (!extension) throw new ExtensionRegistryError('Extension not found', 404);
  const secret = `tre_${randomSecret()}`;
  await getStore().updateDoc(path, { client_secret_hash: sha256(secret), updated_at: new Date().toISOString() });
  return secret;
}

export async function setExtensionVersionLifecycle(args: {
  developerOrgId: string;
  extensionId: string;
  version: string;
  status: 'deprecated' | 'revoked';
  reason?: string;
}): Promise<ExtensionVersion> {
  const store = getStore();
  const versionPath = paths.extensionVersion(args.developerOrgId, args.extensionId, args.version);
  const current = await store.getDoc<ExtensionVersion>(versionPath);
  if (!current) throw new ExtensionRegistryError('Extension version not found', 404);
  if (current.status === 'revoked') throw new ExtensionRegistryError('Revoked versions cannot change state', 409);
  if (!['published', 'deprecated'].includes(current.status)) throw new ExtensionRegistryError('Only published versions can be deprecated or revoked', 409);
  if (args.status === 'revoked' && !args.reason?.trim()) throw new ExtensionRegistryError('A revocation reason is required');
  const now = new Date().toISOString();
  const next: ExtensionVersion = {
    ...current,
    status: args.status,
    deprecated_at: args.status === 'deprecated' ? now : current.deprecated_at,
    revoked_at: args.status === 'revoked' ? now : undefined,
    revocation_reason: args.status === 'revoked' ? args.reason!.trim().slice(0, 2000) : undefined,
  };
  const { id: _id, ...body } = next;
  await store.setDoc(versionPath, body);
  const catalogPath = paths.extensionCatalogEntry(args.extensionId);
  const catalog = await store.getDoc<ExtensionCatalogEntry>(catalogPath);
  if (catalog?.version === args.version && args.status === 'revoked') {
    await store.updateDoc(catalogPath, { status: 'withdrawn', review_note: next.revocation_reason, reviewed_at: now });
  }
  return next;
}

export async function installExtension(args: {
  developerOrgId: string;
  ownerOrgId: string;
  siteId: string;
  actorId: string;
  extensionId: string;
  version: string;
  grantedScopes: ExtensionScope[];
  config?: Record<string, unknown>;
}): Promise<ExtensionInstallation> {
  const store = getStore();
  const extension = await store.getDoc<Extension>(paths.extension(args.developerOrgId, args.extensionId));
  if (!extension || extension.status !== 'active') throw new ExtensionRegistryError('Extension not found or unavailable', 404);
  const version = await store.getDoc<ExtensionVersion>(paths.extensionVersion(args.developerOrgId, args.extensionId, args.version));
  const developerInstalling = args.developerOrgId === args.ownerOrgId;
  const installableStatus = version?.status === 'published'
    || (developerInstalling && (version?.status === 'draft' || version?.status === 'review'));
  if (!version || !installableStatus || version.manifest.distribution !== extension.distribution) {
    throw new ExtensionRegistryError('Installable extension version not found', 404);
  }
  if (extension.distribution === 'private') {
    const orgAllowed = extension.allowed_org_ids?.includes(args.ownerOrgId) ?? false;
    const siteAllowed = extension.allowed_site_ids?.includes(args.siteId) ?? false;
    if (!orgAllowed && !siteAllowed && !developerInstalling) throw new ExtensionRegistryError('Extension is not allowed for this site', 403);
  }
  const requested = new Set(version.manifest.permissions.map((entry) => entry.scope));
  if (args.grantedScopes.some((scope) => !requested.has(scope))) throw new ExtensionRegistryError('Granted scopes must be requested by the manifest');
  const config = buildExtensionConfig(version.manifest.config_schema, args.config ?? {});
  if (typeof config === 'string') throw new ExtensionRegistryError(config);
  const existing = (await store.listDocs<ExtensionInstallation>(paths.extensionInstallations(args.ownerOrgId, args.siteId)))
    .find((entry) => entry.extension_id === args.extensionId && entry.status !== 'revoked');
  if (existing) throw new ExtensionRegistryError('Extension is already installed on this site', 409);
  const now = new Date().toISOString();
  const installation: ExtensionInstallation = {
    id: `inst_${generateDocId()}`,
    extension_id: args.extensionId,
    developer_org_id: args.developerOrgId,
    version: args.version,
    owner_org_id: args.ownerOrgId,
    site_id: args.siteId,
    status: 'enabled',
    granted_scopes: [...new Set(args.grantedScopes)],
    ...config,
    installed_by: args.actorId,
    installed_at: now,
    updated_at: now,
  };
  const { id: _id, ...body } = installation;
  await store.setDoc(paths.extensionInstallation(args.ownerOrgId, args.siteId, installation.id), body);
  await provisionExtensionBlocks(args.ownerOrgId, args.siteId, installation, version.manifest, true);
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId,
    siteId: args.siteId,
    extensionId: args.extensionId,
    installationId: installation.id,
    action: 'extension.installed',
    actorId: args.actorId,
    metadata: { version: args.version, runtime: EXTENSION_RUNTIME_VERSION },
  });
  await (await import('./events')).notifyExtensionLifecycle({ installation, eventType: 'extension.installed' });
  return installation;
}

export async function setExtensionInstallationStatus(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  actorId: string;
  status: 'enabled' | 'disabled';
}): Promise<ExtensionInstallation> {
  const path = paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId);
  const installation = await getStore().getDoc<ExtensionInstallation>(path);
  if (!installation) throw new ExtensionRegistryError('Installation not found', 404);
  if (installation.status === 'revoked') throw new ExtensionRegistryError('Installation is revoked', 409);
  const version = await getStore().getDoc<ExtensionVersion>(paths.extensionVersion(installation.developer_org_id, installation.extension_id, installation.version));
  if (!version) throw new ExtensionRegistryError('Installed extension version not found', 409);
  const now = new Date().toISOString();
  await getStore().updateDoc(path, {
    status: args.status,
    updated_at: now,
    disabled_at: args.status === 'disabled' ? now : undefined,
  });
  await provisionExtensionBlocks(args.ownerOrgId, args.siteId, installation, version.manifest, args.status === 'enabled');
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId,
    siteId: args.siteId,
    extensionId: installation.extension_id,
    installationId: installation.id,
    action: args.status === 'enabled' ? 'extension.enabled' : 'extension.disabled',
    actorId: args.actorId,
  });
  await (await import('./events')).notifyExtensionLifecycle({
    installation: { ...installation, status: args.status, updated_at: now },
    eventType: args.status === 'disabled' ? 'extension.disabled' : 'extension.updated',
  });
  return { ...installation, status: args.status, updated_at: now };
}

export async function updateExtensionInstallation(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  actorId: string;
  version?: string;
  grantedScopes?: ExtensionScope[];
  config?: Record<string, unknown>;
}): Promise<ExtensionInstallation> {
  const store = getStore();
  const installationPath = paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId);
  const current = await store.getDoc<ExtensionInstallation>(installationPath);
  if (!current) throw new ExtensionRegistryError('Installation not found', 404);
  if (current.status === 'revoked') throw new ExtensionRegistryError('Installation is revoked', 409);
  const nextVersionName = args.version ?? current.version;
  const nextVersion = await store.getDoc<ExtensionVersion>(
    paths.extensionVersion(current.developer_org_id, current.extension_id, nextVersionName),
  );
  const extension = await store.getDoc<Extension>(paths.extension(current.developer_org_id, current.extension_id));
  const developerOwned = current.developer_org_id === current.owner_org_id;
  const installableStatus = nextVersion?.status === 'published'
    || (developerOwned && (nextVersion?.status === 'draft' || nextVersion?.status === 'review'));
  if (!nextVersion || !extension || !installableStatus || nextVersion.manifest.distribution !== extension.distribution) {
    throw new ExtensionRegistryError('Installable extension version not found', 404);
  }
  const scopes = args.grantedScopes ?? current.granted_scopes;
  const requested = new Set(nextVersion.manifest.permissions.map((entry) => entry.scope));
  if (scopes.some((scope) => !requested.has(scope))) throw new ExtensionRegistryError('Granted scopes must be requested by the manifest');
  const config = buildExtensionConfig(nextVersion.manifest.config_schema, args.config ?? {}, current);
  if (typeof config === 'string') throw new ExtensionRegistryError(config);
  const previousVersion = current.version !== nextVersionName ? current.version : current.previous_version;
  const now = new Date().toISOString();
  const next: ExtensionInstallation = {
    ...current,
    version: nextVersionName,
    previous_version: previousVersion,
    granted_scopes: [...new Set(scopes)],
    ...config,
    updated_at: now,
  };
  if (current.version !== nextVersionName) {
    const oldVersion = await store.getDoc<ExtensionVersion>(
      paths.extensionVersion(current.developer_org_id, current.extension_id, current.version),
    );
    if (oldVersion) await provisionExtensionBlocks(args.ownerOrgId, args.siteId, current, oldVersion.manifest, false);
  }
  const { id: _id, ...body } = next;
  await store.setDoc(installationPath, body);
  if (next.status === 'enabled') await provisionExtensionBlocks(args.ownerOrgId, args.siteId, next, nextVersion.manifest, true);
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId,
    siteId: args.siteId,
    extensionId: current.extension_id,
    installationId: current.id,
    action: current.version === nextVersionName ? 'extension.config_updated' : 'extension.updated',
    actorId: args.actorId,
    metadata: current.version === nextVersionName ? undefined : { from_version: current.version, to_version: nextVersionName },
  });
  await (await import('./events')).notifyExtensionLifecycle({
    installation: next,
    eventType: 'extension.updated',
    metadata: current.version === nextVersionName ? undefined : { from_version: current.version, to_version: nextVersionName },
  });
  return next;
}

export async function uninstallExtension(args: {
  ownerOrgId: string;
  siteId: string;
  installationId: string;
  actorId: string;
}): Promise<void> {
  const path = paths.extensionInstallation(args.ownerOrgId, args.siteId, args.installationId);
  const installation = await getStore().getDoc<ExtensionInstallation>(path);
  if (!installation) throw new ExtensionRegistryError('Installation not found', 404);
  const version = await getStore().getDoc<ExtensionVersion>(paths.extensionVersion(installation.developer_org_id, installation.extension_id, installation.version));
  if (version) await provisionExtensionBlocks(args.ownerOrgId, args.siteId, installation, version.manifest, false);
  const now = new Date().toISOString();
  await getStore().updateDoc(path, { status: 'revoked', updated_at: now });
  const credentials = await getStore().listDocs(paths.extensionCredentials(args.ownerOrgId, args.siteId, args.installationId));
  for (const credential of credentials) {
    await getStore().updateDoc(paths.extensionCredential(args.ownerOrgId, args.siteId, args.installationId, credential.id), { revoked_at: now });
  }
  await recordExtensionAudit({
    ownerOrgId: args.ownerOrgId,
    siteId: args.siteId,
    extensionId: installation.extension_id,
    installationId: installation.id,
    action: 'extension.uninstalled',
    actorId: args.actorId,
  });
  await (await import('./events')).notifyExtensionLifecycle({ installation, eventType: 'extension.uninstalled' });
}
