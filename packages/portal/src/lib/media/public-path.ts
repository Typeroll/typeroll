import { createHash } from 'node:crypto';
import { paths, type Media } from '@typeroll/shared';
import { getStore, type ReadWriteStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { publicMediaPath } from '../publishing/domain-config';
import { mediaNameMatchesType, allowedMediaExtensions, passiveTypeForName } from './file-types';

type NamedMedia = Media & { source_url?: string };
type Claim = { path: string; sha256: string; mime_type: string };
export const mediaPathClaims = (org: string, site: string) => `${paths.site(org, site)}/media_public_paths`;
const claimId = (path: string) => createHash('sha256').update(decodeURIComponent(path).normalize('NFC')).digest('hex');
const identity = (media: NamedMedia) => JSON.stringify([media.sha256, media.mime_type, media.filename, media.public_path, media.public_path_allocation, media.public_path_history, media.source_url]);
const cleanPath = (path: string) => publicMediaPath(path.normalize('NFC').replace(/[\\%?#\x00-\x20\x7f:*]/g, '_'));

/** A declared WordPress uploads namespace, with site isolation kept outside the filename. */
export function wordpressMediaPath(source: string | undefined): { prefix: string; path: string; source_path: string } | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const match = /^(.*\/wp-content\/uploads\/(?:sites\/\d+\/)?)(.+)$/.exec(url.pathname);
    if (!match) return null;
    // Normalize once before claiming a path; encoded separators and dot segments
    // cannot introduce a different namespace on the public host.
    if (/%(?:2f|5c|2e|25)/i.test(match[2])) return null;
    const path = cleanPath(`/${decodeURIComponent(match[2])}`);
    return { prefix: match[1].slice(0, -1), path, source_path: url.pathname };
  } catch { return null; }
}

export function preferredPublicMediaPath(media: NamedMedia): string {
  const allocation = media.public_path_allocation;
  const explicit = media.public_path && (!allocation || media.public_path !== allocation.path);
  const imported = wordpressMediaPath(media.source_url);
  let path = explicit ? decodeURIComponent(publicMediaPath(media.public_path!)).normalize('NFC')
    : (media.public_path === allocation?.path ? allocation?.base_path : undefined) ?? (media.public_path === null ? undefined : imported?.path);
  if (!path) {
    const filename = media.filename.normalize('NFC');
    try { path = cleanPath(`/${filename}`); }
    catch { path = publicMediaPath(`/${filename.split(/[\\/]/).at(-1)!.replace(/[^\p{L}\p{N}._-]/gu, '_') || 'file'}`); }
  }
  const type = allowedMediaExtensions(media.mime_type).length ? media.mime_type : passiveTypeForName(path) ?? 'application/octet-stream';
  if (!mediaNameMatchesType(path, type)) {
    const extension = allowedMediaExtensions(type)[0];
    if (extension) path += `.${extension}`;
  }
  return publicMediaPath(path);
}

function numbered(path: string, number: number): string {
  if (number === 1) return path;
  const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
  return dot > slash + 1 ? `${path.slice(0, dot)}-${number}${path.slice(dot)}` : `${path}-${number}`;
}

/** Reserve names and the verified byte identity atomically, including concurrent publications. */
export async function allocatePublicMediaPaths(org: string, site: string, selected: NamedMedia[], library: NamedMedia[], options: { dryRun?: boolean; store?: ReadWriteStore } = {}): Promise<Map<string, NamedMedia>> {
  const store = options.store ?? getStore(), root = mediaPathClaims(org, site);
  const [claims, removals] = await Promise.all([
    store.listDocs<Claim>(root), store.listDocs<{ identity: NamedMedia }>(`${paths.site(org, site)}/media_removals`),
  ]);
  const occupied = new Map<string, Claim>();
  for (const claim of claims) occupied.set(claimId(claim.path), claim);
  // Pre-claim libraries and tombstones must also protect names. Deleting a
  // record never makes an old cached URL available for different bytes.
  for (const media of [...library, ...removals.map(item => item.identity)]) {
    if (!media) continue;
    const legacy: Array<{ path: string; sha256: string }> = [];
    for (const address of [media.published_url, ...(media.source_aliases ?? [])]) {
      try {
        const name = decodeURIComponent(new URL(address!).pathname).split('/').at(-1)!;
        if (media.sha256 && name.startsWith(`${media.sha256.slice(0, 16)}-`) && mediaNameMatchesType(name, media.mime_type)) legacy.push({ path: `/${name}`, sha256: media.sha256 });
      } catch { /* Non-public references do not reserve a filename. */ }
    }
    for (const old of [...legacy, ...(media.public_path_history ?? []), ...(media.public_path ? [{ path: media.public_path, sha256: media.public_path_allocation?.sha256 ?? media.sha256 ?? `pending:${media.id}` }] : [])]) {
      try {
        publicMediaPath(old.path);
        const id = claimId(old.path);
        if (!occupied.has(id)) occupied.set(id, { path: old.path, sha256: old.sha256, mime_type: media.mime_type ?? '' });
      } catch { /* Invalid legacy names never become publishable through allocation. */ }
    }
  }
  const result = new Map<string, NamedMedia>();
  for (const media of [...selected].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))) {
    if (!/^[a-f0-9]{64}$/.test(media.sha256 ?? '')) throw new ConnectionError('Verify the file before assigning its public address.', 409, 'media_not_ready');
    const base = preferredPublicMediaPath(media), mime = media.mime_type ?? '';
    let expected = media, assigned: NamedMedia | undefined, conflicts = 0;
    for (let number = 1; number <= 10000; number++) {
      const path = numbered(base, number), id = claimId(path), taken = occupied.get(id);
      if (taken && (taken.sha256 !== media.sha256 || taken.mime_type !== mime)) continue;
      const allocation = media.public_path_allocation;
      if (allocation && allocation.sha256 === media.sha256 && allocation.path === media.public_path && path !== media.public_path) continue;
      const history = [...(media.public_path_history ?? [])];
      if (allocation && allocation.path !== path && !history.some(old => old.path === allocation.path && old.sha256 === allocation.sha256)) history.push({ path: allocation.path, sha256: allocation.sha256 });
      const next = { ...expected, public_path: path, public_path_allocation: { base_path: base, path, sha256: media.sha256! }, ...(history.length ? { public_path_history: history } : {}) };
      if (options.dryRun) { assigned = next; occupied.set(id, { path, sha256: media.sha256!, mime_type: mime }); break; }
      // A pinned assignment needs no write or new reservation on later builds.
      if (allocation && allocation.sha256 === media.sha256 && allocation.path === path && media.public_path === path) { assigned = media; break; }
      const claimPath = `${root}/${id}`, claim = await store.getDoc<Claim>(claimPath);
      if (claim && (claim.sha256 !== media.sha256 || claim.mime_type !== mime)) { occupied.set(id, claim); continue; }
      const { id: _id, ...data } = next;
      if (await store.compareAndReplaceDoc(`${paths.media(org, site)}/${media.id}`, expected as unknown as Record<string, any>, data,
        [{ path: claimPath, expected: claim, data: { path, sha256: media.sha256, mime_type: mime }, ...(claim ? { guardOnly: true } : {}) }])) {
        assigned = next; occupied.set(id, { path, sha256: media.sha256!, mime_type: mime }); break;
      }
      const current = await store.getDoc<NamedMedia>(`${paths.media(org, site)}/${media.id}`);
      if (++conflicts >= 8) throw new ConnectionError('Media changed while assigning its public address. Retry publishing.', 409, 'media_revision_conflict');
      if (!current || identity(current) !== identity(media)) throw new ConnectionError('Media changed while assigning its public address. Retry publishing.', 409, 'media_revision_conflict');
      expected = current;
      number--; // Retry this candidate after an unrelated metadata update or competing claim.
      const competing = await store.getDoc<Claim>(claimPath);
      if (competing) occupied.set(id, competing);
    }
    if (!assigned) throw new ConnectionError('No free public filename was found. Choose another name or folder.', 409, 'media_path_collision');
    result.set(media.id, assigned);
  }
  return result;
}
