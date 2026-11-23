import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { mediaReadiness, privateMediaReferences } from './readiness';

/** Check newly introduced references only: existing broken content must remain editable. */
export async function mediaReferenceIssue(ctx: { orgId: string; siteId: string }, value: unknown, previous?: unknown) {
  const before = new Set(privateMediaReferences(previous).map(ref => `${ref.siteId}/${ref.mediaId}`));
  const added = privateMediaReferences(value).filter(ref => !before.has(`${ref.siteId}/${ref.mediaId}`));
  // No library scan on ordinary edits; look up only newly introduced identities.
  for (const ref of added) {
    const media = ref.siteId === ctx.siteId ? await getStore().getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${ref.mediaId}`) : null;
    const readiness = media ? mediaReadiness(media) : null;
    if (!readiness?.selectable) return { code: 'media_not_ready',
      message: `Media ${ref.mediaId} is not available for selection. Wait for a verified import or upload, or choose a replacement from this site's media library.`,
      details: { media_id: ref.mediaId, state: readiness?.state ?? 'missing' } };
  }
  return null;
}
