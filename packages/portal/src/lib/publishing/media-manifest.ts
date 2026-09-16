import { findReferences, replaceReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, ConnectionError } from './connections';
import { getSiteDomains, getOrganizationDomains, markOrganizationMediaHostUsed, publicMediaPath } from './domain-config';
import { siteMediaPrefix } from '../media-keys';

/** Stable private media identities in serialized content, never signed URLs. */
export function privateMediaReferences(value: unknown): Array<{ siteId: string; mediaId: string }> {
  const found = new Map<string, { siteId: string; mediaId: string }>();
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const match of (serialized ?? '').matchAll(/\/api\/sites\/([a-zA-Z0-9_%.-]+)\/media\/([a-zA-Z0-9_%.-]+)\/content(?=[?#\s"'<>),\]\\]|$)/g)) {
    try {
      const siteId = decodeURIComponent(match[1]), mediaId = decodeURIComponent(match[2]);
      if (siteId.includes('/') || mediaId.includes('/')) continue;
      found.set(`${siteId}/${mediaId}`, { siteId, mediaId });
    } catch { /* Invalid encoded paths cannot resolve to a stored media identity. */ }
  }
  return [...found.values()];
}
function assertPublicMediaReferences(content: unknown) {
  const unresolved = privateMediaReferences(content);
  if (unresolved.length) throw new ConnectionError(`Cannot publish: ${unresolved.length} image or file reference(s) still use a private Typeroll address. Re-select or re-import media ${unresolved[0].mediaId} from this site's Media library, then try again.`, 409, 'media_reference_unresolved');
}

export function replacePublicationReferences<T>(value: T, replacements: Map<string, string>): T {
  return replaceReferences(value, replacements);
}

/** Image bytes and temporary credentials are excluded; Git contains identity, hashes and public routing only. */
export async function publicationMediaManifest<T extends Record<string, any>>(orgId: string, siteId: string, content: T, websiteHost: string, previousPublication?: Record<string, any>, options: { deferReferences?: boolean } = {}) {
  const [all, connection, domains, organization, prefix] = await Promise.all([
    getStore().listDocs<Media>(paths.media(orgId, siteId)), getConnection(orgId, 'cloudflare'), getSiteDomains(orgId, siteId),
    getOrganizationDomains(orgId), siteMediaPrefix(orgId, siteId),
  ]);
  if (previousPublication?.media_manifest) {
    all.splice(0, all.length, ...previousPublication.media_manifest.entries.map((entry: any) => ({ ...entry,
      public_path: entry.public_path.slice(previousPublication.media_manifest.media_host === organization.media_host ? prefix.length + 1 : (previousPublication.media_manifest.media_path_prefix ?? '').length),
      storage: { provider: 'organization_r2', state: 'ready', account_id: previousPublication.media_manifest.account_id, bucket: previousPublication.media_manifest.original_bucket, key: entry.source_key },
      source_aliases: [entry.cdn_url.replace(previousPublication.site_url, `https://${websiteHost}`), entry.cdn_url, ...entry.aliases.map((alias: any) => alias.url)],
    })));
  }
  const serialized = JSON.stringify(content);
  const references = (item: Media) => [item.cdn_url, ...(item.source_aliases ?? []), ...(item.variants ?? []).map(variant => variant.cdn_url)].filter(Boolean);
  const found = findReferences(serialized, all.flatMap(references));
  const media = all.filter(item => references(item).some(url => found.has(url)));
  if (!media.length) { assertPublicMediaReferences(content); return { content, media: [], sourceMedia: [], manifest: null }; }
  if (!connection.cloudflare?.public_bucket || !connection.media_ready) throw new ConnectionError('Complete private and public R2 storage setup in Publishing.', 409, 'media_storage_required');
  const host = content.git_branch && content.git_branch !== 'main' ? websiteHost : domains.desired.media_host || websiteHost;
  if (!host) throw new ConnectionError('Set a media host in Publishing before deploying images.', 409, 'media_domain_required');
  const organizationHost = organization.media_host;
  const sharedHost = host === organizationHost;
  const delivery = sharedHost || (domains.active?.media_host === host && host !== websiteHost) ? 'r2' : 'static';
  const publicPrefix = sharedHost ? `/${prefix}` : domains.desired.media_path_prefix || (host === websiteHost ? '/media' : '');
  const replacements = new Map<string, string>();
  const pathsSeen = new Set<string>();
  const entries = media.map(item => {
    if (item.storage?.provider !== 'organization_r2' || item.storage.state !== 'ready' || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') ||
        item.storage.account_id !== connection.cloudflare!.account_id || item.storage.bucket !== connection.cloudflare!.bucket) {
      throw new ConnectionError('Some referenced media is still uploading or migrating to your R2 account. Wait for media setup to finish, then deploy again.', 409, 'media_migration_pending');
    }
    const relative = item.public_path ? publicMediaPath(item.public_path) : `/${item.sha256!.slice(0, 16)}-${item.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const publicPath = publicMediaPath(`${publicPrefix}${relative}`);
    if (pathsSeen.has(publicPath)) throw new ConnectionError('Two media files use the same public path. Choose distinct paths before publishing.', 409, 'media_path_collision');
    pathsSeen.add(publicPath);
    const url = `https://${host}${publicPath}`;
    const publicKey = `${prefix}${sharedHost ? relative : publicPath}`;
    const aliases = organizationHost ? [{ url: `https://${organizationHost}/${prefix}${relative}`, key: `${prefix}${relative}` }] : [];
    for (const retained of [...domains.media_aliases, ...(domains.active ? [domains.active] : [])]) {
      const retainedHost = retained.media_host || organizationHost;
      if (!retainedHost || retainedHost === retained.website_host) continue;
      const retainedPath = retainedHost === organizationHost ? `/${prefix}${relative}` : `${retained.media_path_prefix}${relative}`;
      const key = retainedHost === organizationHost ? `${prefix}${relative}` : `${prefix}${retainedPath}`;
      const retainedUrl = `https://${retainedHost}${retainedPath}`;
      if (!aliases.some(alias => alias.url === retainedUrl)) aliases.push({ url: retainedUrl, key });
    }
    replacements.set(item.cdn_url, url);
    for (const alias of item.source_aliases ?? []) replacements.set(alias, url);
    // Existing responsive URLs remain valid aliases; the current build regenerates its own variant list.
    for (const variant of item.variants ?? []) replacements.set(variant.cdn_url, url);
    return { id: item.id, filename: item.filename, mime_type: item.mime_type, alt_text: item.alt_text, title: item.title, caption: item.caption,
      cdn_url: url, variants: [], source_key: item.storage.key, sha256: item.sha256, size_bytes: item.size_bytes,
      public_key: publicKey, public_path: publicPath, aliases };
  });
  for (const [alias, previousTarget] of previousPublication?.reference_mapping?.media ?? []) {
    const nextTarget = replacements.get(previousTarget);
    if (nextTarget) replacements.set(alias, nextTarget);
  }
  const publicContent = options.deferReferences
    ? { ...content, reference_mapping: { format: 1, media: [...replacements], website_origins: [] } }
    : replacePublicationReferences(content, replacements);
  if (options.deferReferences) {
    // Validate exact references, not only media IDs: another host can contain
    // the same private path without being a registered source alias.
    const { reference_mapping: _mapping, ...authored } = content;
    if (privateMediaReferences(authored).length) assertPublicMediaReferences(replacePublicationReferences(authored, replacements));
  } else assertPublicMediaReferences(publicContent);
  await markOrganizationMediaHostUsed(orgId, organization);
  return { content: publicContent, media: entries, sourceMedia: media,
    manifest: { delivery, account_id: connection.cloudflare.account_id, original_bucket: connection.cloudflare.bucket, public_bucket: connection.cloudflare.public_bucket,
      media_host: host, website_host: websiteHost, dns_mode: domains.dns_mode, media_path_prefix: publicPrefix, site_prefix: prefix, entries } };
}

/** Keep old public routes without preparing identical current files a second time. */
export function retainDistinctMediaManifests(previous: any[], current: any): any[] {
  const namespace = (manifest: any) => JSON.stringify(['account_id', 'original_bucket', 'public_bucket', 'site_prefix', 'delivery', 'media_host', 'website_host', 'media_path_prefix'].map(field => manifest[field] ?? null));
  const identity = (entry: any) => JSON.stringify([entry.id, entry.source_key, entry.sha256, entry.public_key, entry.public_path]);
  const known = new Map<string, Map<string, Set<string>>>();
  const add = (manifest: any, entry: any) => {
    const target = namespace(manifest), files = known.get(target) ?? new Map<string, Set<string>>();
    const key = identity(entry), aliases = files.get(key) ?? new Set<string>();
    for (const alias of entry.aliases ?? []) aliases.add(JSON.stringify([alias.url, alias.key]));
    files.set(key, aliases); known.set(target, files);
  };
  for (const entry of current?.entries ?? []) add(current, entry);
  const retained = [];
  for (const manifest of previous) {
    const entries = manifest.entries.filter((entry: any) => {
      const aliases = known.get(namespace(manifest))?.get(identity(entry));
      const covered = aliases && (entry.aliases ?? []).every((alias: any) => aliases.has(JSON.stringify([alias.url, alias.key])));
      add(manifest, entry);
      return !covered;
    });
    if (entries.length) retained.push({ ...manifest, entries });
  }
  return retained;
}
