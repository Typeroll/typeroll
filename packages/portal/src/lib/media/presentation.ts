import type { Media } from '@typeroll/shared';

/** Only public locations belong in sharing controls. Editor references stay private. */
export function publicMediaUrl(media: Media): string | null {
  const file = media.file_publication;
  const candidate = file?.state === 'public' && file.sha256 === media.sha256 ? file.url
    : media.published_url || (!media.storage ? media.cdn_url : null);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.pathname.startsWith('/api/') ? candidate : null;
  } catch { return null; }
}
