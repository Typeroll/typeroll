import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, ConnectionError } from './connections';
import { getSiteDomains, getOrganizationDomains, markOrganizationMediaHostUsed, publicMediaPath } from './domain-config';
import { siteMediaPrefix } from '../media-keys';

export function replacePublicationReferences<T>(value: T, replacements: Map<string, string>): T {
  const ordered = [...replacements.entries()].sort(([a], [b]) => b.length - a.length);
  const visit = (input: unknown, field = ''): unknown => {
    if (typeof input === 'string' && field !== 'canonical_url') {
      let result = input;
      for (const [from, to] of ordered) {
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`${escaped}(?=[?#\\s"'<>),\\]\\\\]|$)`, 'g'), () => to);
      }
      return result;
    }
    if (Array.isArray(input)) return input.map(item => visit(item));
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, visit(item, key)]));
    return input;
  };
  return visit(value) as T;
}

/** Image bytes and temporary credentials are excluded; Git contains identity, hashes and public routing only. */
export async function publicationMediaManifest<T extends Record<string, any>>(orgId: string, siteId: string, content: T, websiteHost: string, previousPublication?: Record<string, any>) {
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
  const media = all.filter(item => [item.cdn_url, ...(item.source_aliases ?? []), ...(item.variants ?? []).map(variant => variant.cdn_url)].some(url => url && serialized.includes(url)));
  if (!media.length) return { content, media: [], manifest: null };
  if (!connection.cloudflare?.public_bucket || !connection.media_ready) throw new ConnectionError('Complete private and public R2 storage setup in Publishing.', 409, 'media_storage_required');
  const host = domains.desired.media_host || organization.media_host;
  if (!host) throw new ConnectionError('Set a media host in Publishing before deploying images.', 409, 'media_domain_required');
  const organizationHost = organization.media_host;
  const sharedHost = host === organizationHost;
  const publicPrefix = sharedHost ? `/${prefix}` : domains.desired.media_path_prefix;
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
  await markOrganizationMediaHostUsed(orgId, organization);
  return { content: replacePublicationReferences(content, replacements), media: entries,
    manifest: { account_id: connection.cloudflare.account_id, original_bucket: connection.cloudflare.bucket, public_bucket: connection.cloudflare.public_bucket,
      media_host: host, website_host: websiteHost, dns_mode: domains.dns_mode, media_path_prefix: publicPrefix, site_prefix: prefix, entries } };
}
