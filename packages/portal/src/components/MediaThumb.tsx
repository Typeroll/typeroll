import { useRef } from 'react';
import type { Media } from '@typeroll/shared';

/** What a media item is, for its thumbnail, the type filter and which fields may use it. */
export type MediaKind = 'image' | 'video' | 'pdf' | 'audio' | 'other';
export type MediaFilter = 'all' | MediaKind;

export function mediaKind(item: Pick<Media, 'mime_type' | 'filename'>): MediaKind {
  const type = (item.mime_type ?? '').toLowerCase();
  const name = (item.filename ?? '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|heic|heif|jxl)$/.test(name)) return 'image';
  if (type.startsWith('video/') || /\.(mp4|m4v|webm|mov)$/.test(name)) return 'video';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|m4a)$/.test(name)) return 'audio';
  return 'other';
}

const LABELS: Record<MediaFilter, string> = { all: 'All', image: 'Images', video: 'Videos', pdf: 'PDFs', audio: 'Audio', other: 'Other files' };

/** The smallest prepared image variant that still fills a thumbnail, else the original. */
function thumbnailSource(item: Media, width: number): string {
  const variants = (item.variants ?? []).filter((variant) => variant.cdn_url && variant.width && variant.width >= width);
  variants.sort((a, b) => (a.width ?? 0) - (b.width ?? 0) || (a.format === 'webp' ? -1 : 1));
  return variants[0]?.cdn_url ?? item.cdn_url;
}

const extension = (item: Media) => (item.filename.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? item.mime_type?.split('/')[1] ?? 'file').toUpperCase();

const DOCUMENT_ICON = (
  <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />
  </svg>
);
const AUDIO_ICON = (
  <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);

/**
 * A square thumbnail for any media item: the image, a frame of the video
 * (which plays, muted, while pointed at or focused), or an icon with the
 * file type for documents, audio and other files.
 */
export function MediaThumb({ item, size = 160 }: { item: Media; size?: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const kind = mediaKind(item);
  // Logos and graphics (often transparent) show whole on a light ground; photos fill the square.
  const graphic = /\.(png|svg|gif|ico)$/i.test(item.filename) || /svg|png|gif|icon/.test(item.mime_type ?? '');
  if (kind === 'image') return <img className={`mthumb mthumb--image${graphic ? ' mthumb--graphic' : ''}`} src={thumbnailSource(item, size)} alt="" loading="lazy" decoding="async" />;
  if (kind === 'video') {
    const play = () => { const node = video.current; if (node) { node.muted = true; void node.play().catch(() => {}); } };
    const stop = () => { const node = video.current; if (node) { node.pause(); node.currentTime = 0.5; } };
    return (
      <span className="mthumb mthumb--video" onMouseEnter={play} onMouseLeave={stop} onFocus={play} onBlur={stop}>
        {/* #t=0.5 shows a frame from the clip instead of a black first frame. */}
        <video ref={video} src={`${item.cdn_url}#t=0.5`} muted playsInline loop preload="metadata" aria-hidden="true" tabIndex={-1} />
        <span className="mthumb__badge" aria-hidden="true">▶</span>
      </span>
    );
  }
  return (
    <span className={`mthumb mthumb--file mthumb--${kind}`}>
      {kind === 'audio' ? AUDIO_ICON : DOCUMENT_ICON}
      <span className="mthumb__type">{kind === 'pdf' ? 'PDF' : extension(item)}</span>
    </span>
  );
}

/** Buttons that narrow a media list to one kind, with how many of each there are. */
export function MediaKindFilter({ items, value, onChange, kinds }: { items: Media[]; value: MediaFilter; onChange: (next: MediaFilter) => void; kinds?: MediaKind[] }) {
  const counts = items.reduce<Record<string, number>>((all, item) => { const kind = mediaKind(item); all[kind] = (all[kind] ?? 0) + 1; return all; }, {});
  const offered: MediaFilter[] = kinds && kinds.length === 1 ? [] : ['all', ...(kinds ?? (['image', 'video', 'pdf', 'audio', 'other'] as MediaKind[])).filter((kind) => counts[kind])];
  if (offered.length <= 2) return null;
  return (
    <div className="mfilter" role="group" aria-label="Show">
      {offered.map((kind) => (
        <button key={kind} type="button" className="mfilter__btn" aria-pressed={value === kind} onClick={() => onChange(kind)}>
          {LABELS[kind]} <span className="mfilter__count">{kind === 'all' ? items.length : counts[kind]}</span>
        </button>
      ))}
    </div>
  );
}

export function filterMedia(items: Media[], filter: MediaFilter, query = '', kinds?: MediaKind[]): Media[] {
  const text = query.trim().toLowerCase();
  return items.filter((item) => {
    const kind = mediaKind(item);
    if (kinds && !kinds.includes(kind)) return false;
    if (filter !== 'all' && kind !== filter) return false;
    return !text || item.filename.toLowerCase().includes(text) || (item.alt_text ?? '').toLowerCase().includes(text) || (item.title ?? '').toLowerCase().includes(text);
  });
}

/** Styles for thumbnails and the filter, shared by the media library and the picker. */
export const mediaThumbStyles = `
.mthumb { display:block; width:100%; aspect-ratio:1; border-radius:inherit; overflow:hidden; }
.mthumb--image { object-fit:cover; }
img.mthumb.mthumb--graphic { object-fit:contain; padding:10%; box-sizing:border-box; background:#f4f4f5; }
.mthumb--video { position:relative; background:#18181b; }
.mthumb--video video { width:100%; height:100%; object-fit:cover; display:block; }
.mthumb__badge { position:absolute; inset-inline-end:6px; inset-block-end:6px; display:grid; place-items:center; width:22px; height:22px; border-radius:999px; background:rgb(0 0 0 / .6); color:#fff; font-size:10px; }
.mthumb--file { display:grid; place-content:center; justify-items:center; gap:4px; background:#f4f4f5; color:#52525b; }
.mthumb--pdf { color:#b91c1c; background:#fef2f2; }
.mthumb--audio { color:#6d28d9; background:#f5f3ff; }
.mthumb__type { font:600 11px/1 system-ui, sans-serif; letter-spacing:.04em; }
.mfilter { display:flex; flex-wrap:wrap; gap:6px; }
.mfilter__btn { display:inline-flex; align-items:center; gap:6px; padding:.3rem .65rem; border-radius:999px; border:1px solid var(--color-border, #d4d4d8); background:transparent; color:inherit; font-size:.8rem; cursor:pointer; }
.mfilter__btn[aria-pressed="true"] { background:var(--color-primary, #4f46e5); border-color:var(--color-primary, #4f46e5); color:#fff; }
.mfilter__btn:focus-visible { outline:2px solid #818cf8; outline-offset:2px; }
.mfilter__count { opacity:.75; font-variant-numeric:tabular-nums; }
`;
