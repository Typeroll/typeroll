import { findReferences, replaceReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';
import { paths, type Media, type Redirect } from '@typeroll/shared';
import { createHash } from 'node:crypto';
import { getStore } from '../datastore';
import { getConnection, ConnectionError } from './connections';
import { getSiteDomains, getOrganizationDomains, markOrganizationMediaHostUsed, publicMediaPath, type DomainConfiguration } from './domain-config';
import { siteMediaPrefix } from '../media-keys';
import { allowedMediaExtensions, isScriptableMediaType, mediaNameMatchesType, mediaTypeEssence, passiveTypeForName, SVG_MEDIA_TYPE } from '../media/file-types';

type MarkedMedia = Media & { svg_sanitized?: { sha256?: string } };
/** Only SVG bytes written by the sanitizer may be published (lib/media/svg-media.ts). */
const sanitizedSvg = (item: MarkedMedia | undefined, sha256: string | undefined) => !!item && !!sha256 && item.svg_sanitized?.sha256 === sha256;

/**
 * Static hosts serve a file with the Content-Type of its extension. A path
 * whose extension does not belong to the media type gets the type's canonical
 * extension appended (references are rewritten to the new URL), and a type
 * this server does not publish is served as application/octet-stream.
 */
export function publishableMediaPath(relative: string, mimeType: string | undefined): { path: string; mime_type: string; renamed: boolean } {
  const allowed = allowedMediaExtensions(mimeType);
  if (!allowed.length) {
    // Missing or unknown type: keep a name the host already serves as a passive type, otherwise serve a download.
    const inferred = passiveTypeForName(relative);
    return inferred ? { path: relative, mime_type: inferred, renamed: false } : publishableMediaPath(relative, 'application/octet-stream');
  }
  if (mediaNameMatchesType(relative, mimeType)) return { path: relative, mime_type: mimeType!, renamed: false };
  return { path: `${relative}.${allowed[0]}`, mime_type: mimeType!, renamed: true };
}

/** Retained (older) manifests keep only entries that are still safe to serve. */
function safeRetainedEntry(entry: any): boolean {
  if (typeof entry?.public_path !== 'string') return false;
  const type = allowedMediaExtensions(entry.mime_type).length ? entry.mime_type : passiveTypeForName(entry.public_path);
  if (!type || !mediaNameMatchesType(entry.public_path, type)) return false;
  return mediaTypeEssence(entry.mime_type) !== SVG_MEDIA_TYPE || entry.svg_sanitized === true;
}

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
export async function publicationMediaManifest<T extends Record<string, any>>(orgId: string, siteId: string, content: T, websiteHost: string, previousPublication?: Record<string, any>, options: { deferReferences?: boolean; domains?: DomainConfiguration; dryRun?: boolean } = {}) {
  const [all, connection, storedDomains, organization, prefix] = await Promise.all([
    getStore().listDocs<Media>(paths.media(orgId, siteId)), getConnection(orgId, 'cloudflare'), getSiteDomains(orgId, siteId),
    getOrganizationDomains(orgId), siteMediaPrefix(orgId, siteId),
  ]);
  const domains = options.domains ?? storedDomains;
  const stored = new Map<string, MarkedMedia>(all.map(item => [item.id, item]));
  const fromPrevious = Boolean(previousPublication?.media_manifest);
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
  if (!media.length) { assertPublicMediaReferences(content); return { content, media: [], sourceMedia: [], warnings: [] as string[], manifest: null }; }
  if (!connection.cloudflare?.public_bucket || !connection.media_ready) throw new ConnectionError('Complete private and public R2 storage setup in Publishing.', 409, 'media_storage_required');
  const host = content.git_branch && content.git_branch !== 'main' ? websiteHost : domains.desired.media_host || websiteHost;
  if (!host) throw new ConnectionError('Set a media host in Publishing before deploying images.', 409, 'media_domain_required');
  const organizationHost = organization.media_host;
  const sharedHost = host === organizationHost;
  const delivery = sharedHost || (domains.active?.media_host === host && host !== websiteHost) ? 'r2' : 'static';
  const publicPrefix = sharedHost ? `/${prefix}` : domains.desired.media_path_prefix || (host === websiteHost ? '/media' : '');
  const replacements = new Map<string, string>();
  const pathsSeen = new Set<string>();
  const warnings: string[] = [];
  for (const item of media) {
    if (item.storage?.provider !== 'organization_r2' || item.storage.state !== 'ready' || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') ||
        item.storage.account_id !== connection.cloudflare!.account_id || item.storage.bucket !== connection.cloudflare!.bucket) {
      throw new ConnectionError('Some referenced media is still uploading or migrating to your R2 account. Wait for media setup to finish, then deploy again.', 409, 'media_migration_pending');
    }
  }
  // SVG stored before sanitizing existed is sanitized now, before anything is
  // published. (A passive type under an .svg name is renamed below instead.)
  // A dry run checks the same files in memory and writes nothing.
  const unsanitized = fromPrevious ? [] : media.filter(item => isScriptableMediaType(item.mime_type) && !sanitizedSvg(stored.get(item.id), item.sha256));
  const rejected = new Map<string, string>();
  if (unsanitized.length) {
    const { resanitizeStoredSvgMedia } = await import('../media/svg-media');
    const report = await resanitizeStoredSvgMedia(orgId, siteId, { apply: !options.dryRun, mediaIds: unsanitized.map(item => item.id) });
    for (const entry of report.rejected) rejected.set(entry.media_id, entry.error);
    for (const entry of report.skipped) rejected.set(entry.media_id, entry.reason);
    if (options.dryRun) {
      // Nothing was written: a file the sanitizer accepts counts as publishable.
      for (const item of unsanitized) if (!rejected.has(item.id)) stored.set(item.id, { ...item, svg_sanitized: { sha256: item.sha256 } });
    } else {
      for (const item of unsanitized) {
        const fresh = await getStore().getDoc<MarkedMedia>(`${paths.media(orgId, siteId)}/${item.id}`);
        if (fresh) { stored.set(item.id, fresh); media.splice(media.indexOf(item), 1, fresh); }
      }
    }
  }
  // Media that cannot be published safely is left out of this publication.
  const excluded = new Set<string>();
  for (const item of media) {
    if (!isScriptableMediaType(item.mime_type) || sanitizedSvg(stored.get(item.id), item.sha256)) continue;
    // Entries of a frozen publication carry the flag this builder recorded.
    if (fromPrevious && (item as { svg_sanitized?: unknown }).svg_sanitized === true) continue;
    // A domain change rebuilds the last publication exactly, so it cannot drop a file.
    if (fromPrevious) throw new ConnectionError(`Cannot prepare the domain change: the last publication contains the SVG ${item.filename}, stored before SVG files were sanitized. Publish the site once before changing domains, then prepare the domain change again.`, 409, 'media_svg_unsanitized');
    excluded.add(item.id);
    const reason = rejected.get(item.id);
    warnings.push(`Media ${item.id} (${item.filename}) was not published: the SVG could not be made safe${reason ? ` (${reason.replace(/\.$/, '')})` : ''}. References to it were left empty. Export it again as a plain SVG, upload it and select the new file.`);
  }
  for (const item of media.filter(candidate => excluded.has(candidate.id))) {
    // Never publish a private Typeroll address; an empty reference renders as no file.
    for (const url of references(item)) replacements.set(url, '');
    media.splice(media.indexOf(item), 1);
  }
  const entries = media.map(item => {
    if (!item.storage) throw new ConnectionError('Media storage changed during publishing. Deploy again.', 409, 'media_migration_pending');
    const chosen = item.public_path ? publicMediaPath(item.public_path) : `/${item.sha256!.slice(0, 16)}-${item.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const svg = isScriptableMediaType(item.mime_type);
    const safe = publishableMediaPath(chosen, svg ? SVG_MEDIA_TYPE : item.mime_type);
    if (safe.renamed) warnings.push(`Media ${item.id} (${item.filename}) is published at ${safe.path} because its name did not match its type ${mediaTypeEssence(item.mime_type) || 'unknown'}.`);
    const relative = safe.path;
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
    return { id: item.id, filename: item.filename, mime_type: safe.mime_type, alt_text: item.alt_text, title: item.title, caption: item.caption,
      cdn_url: url, variants: [], source_key: item.storage.key, sha256: item.sha256, size_bytes: item.size_bytes,
      public_key: publicKey, public_path: publicPath, aliases, ...(svg ? { svg_sanitized: true } : {}) };
  });
  for (const warning of warnings) console.warn(`[media-manifest] site ${siteId}: ${warning}`);
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
  return { content: publicContent, media: entries, sourceMedia: media, warnings,
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
    // Entries from before extension and SVG checks existed are not served again.
    const entries = manifest.entries.filter(safeRetainedEntry).filter((entry: any) => {
      const aliases = known.get(namespace(manifest))?.get(identity(entry));
      const covered = aliases && (entry.aliases ?? []).every((alias: any) => aliases.has(JSON.stringify([alias.url, alias.key])));
      add(manifest, entry);
      return !covered;
    });
    if (entries.length) retained.push({ ...manifest, entries });
  }
  return retained;
}

/** Replace retired unsafe bytes with a redirect to the same media record's safe output.
 * Do not retain an unsanitized SVG, infer replacements from filenames, or exempt
 * genuinely deleted files from public verification.
 */
export function replacedMediaRedirects(previous: any[], current: any, existing: Redirect[] = [], retained: Array<Redirect & { media_id: string }> = []): Array<Redirect & { media_id: string }> {
  const staticManifests = [...previous.filter(manifest => manifest.delivery === 'static' || manifest.media_host === manifest.website_host),
    ...(current?.delivery === 'static' ? [current] : [])];
  const output = staticManifests.flatMap(manifest => (manifest.entries ?? []).filter(safeRetainedEntry));
  const entries = new Map<string, any>(output.map((entry: any) => [entry.id, entry]));
  const occupied = new Set<string>(output.map((entry: any) => entry.public_path));
  const redirects = new Map<string, Redirect & { media_id: string }>();
  const retired = [...previous.flatMap(manifest => (manifest.entries ?? []).filter((entry: any) => !safeRetainedEntry(entry))),
    ...retained.map(rule => ({ id: rule.media_id, public_path: rule.from_path }))];
  for (const entry of retired) {
    const replacement = entries.get(entry.id);
    if (!replacement || !safeRetainedEntry(replacement)) continue;
    const from = publicMediaPath(entry.public_path), to = publicMediaPath(replacement.public_path);
    if (from === to) continue; // Current bytes are verified at this unchanged path.
    if (/[*:]/.test(decodeURIComponent(from) + decodeURIComponent(to)))
      throw new ConnectionError('A media replacement path contains redirect pattern characters. Choose a literal public path before publishing.', 409, 'media_redirect_conflict');
    if (occupied.has(from)) throw new ConnectionError('An older media address conflicts with another current file.', 409, 'media_path_collision');
    const authored = existing.find(rule => rule.from_path === from);
    if (authored && (authored.to_path !== to || authored.status_code !== 301))
      throw new ConnectionError(`The redirect at ${from} conflicts with the safe replacement for this media file. Remove or update that redirect before publishing.`, 409, 'media_redirect_conflict');
    if (redirects.has(from) && redirects.get(from)!.to_path !== to)
      throw new ConnectionError('Two older media records claim the same public address.', 409, 'media_redirect_conflict');
    redirects.set(from, { id: `media-replacement-${createHash('sha256').update(from).digest('hex').slice(0, 32)}`, media_id: entry.id, from_path: from, to_path: to, status_code: 301 } as Redirect & { media_id: string });
  }
  return [...redirects.values()].sort((a, b) => a.from_path.localeCompare(b.from_path));
}
