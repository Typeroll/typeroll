import { useEffect, useState } from 'react';
import type { Media } from '@typeroll/shared';
import { finalizeUpload } from '../lib/media/client-upload';
import { filterMedia, mediaKind, MediaKindFilter, MediaThumb, mediaThumbStyles, type MediaFilter, type MediaKind } from './MediaThumb';

/** What a field takes: an image, a video, a sound, or any file. */
export type PickerKind = 'image' | 'video' | 'audio' | 'any';
const KINDS: Record<PickerKind, MediaKind[] | undefined> = { image: ['image'], video: ['video'], audio: ['audio'], any: undefined };
const ACCEPT: Record<PickerKind, string> = { image: 'image/*', video: 'video/mp4,video/webm', audio: '', any: 'image/*,application/pdf,video/mp4,video/webm' };
const NOUN: Record<PickerKind, string> = { image: 'an image', video: 'a video', audio: 'a sound file', any: 'a file' };

interface Props {
  value: string;
  onChange: (url: string) => void;
  siteId: string;
  /** Id for the address input, so a field label can point at it. */
  id?: string;
  /** Accessible name of the address input when no label points at it. */
  label?: string;
  /** `dark` for the editors' dark panels. */
  theme?: 'light' | 'dark';
  /** What the field takes; the library shows only that, or every kind with a filter for `any`. */
  kind?: PickerKind;
}

// Compact field used inside other forms (page editor inspector, block type
// preview data) to pick an image, a video or any file from the media library,
// upload one, or type an address.
export default function MediaPicker({ value, onChange, siteId, id, label, theme = 'light', kind = 'image' }: Props) {
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || items.length > 0) return;
    setLoading(true);
    fetch(`/api/sites/${siteId}/media`)
      .then((r) => r.json())
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch(() => setError('Could not load the media library.'))
      .finally(() => setLoading(false));
  }, [open, items.length, siteId]);

  async function uploadFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const presign = await fetch(`/api/sites/${siteId}/media/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });
      const data = await presign.json();
      if (!presign.ok) throw new Error(data.error ?? 'Upload failed');
      const put = await fetch(data.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      // Finalize verifies the file (and sanitizes SVG). A refused file is
      // removed again and its reason shown instead of a broken image.
      await finalizeUpload(siteId, data);
      onChange(data.cdnUrl);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={`media-picker media-picker--${theme}`}>
      <div className="media-picker__row">
        <input
          id={id}
          aria-label={id ? undefined : label ?? (kind === 'image' ? 'Image address' : kind === 'video' ? 'Video address' : 'File address')}
          type="text"
          inputMode="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://… or choose from the library"
          className="media-picker__input"
        />
      </div>
      <div className="media-picker__row">
        <button type="button" className="media-picker__btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Media library
        </button>
        {ACCEPT[kind] && <label className="media-picker__btn">
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            accept={ACCEPT[kind]}
            className="media-picker__file"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadFile(f);
              e.target.value = '';
            }}
          />
        </label>}
        {value && <button type="button" className="media-picker__btn" onClick={() => onChange('')}>Remove</button>}
      </div>

      {value && <Selected value={value} items={items} kind={kind} />}
      {error && <p role="alert" className="media-picker__error">{error}</p>}

      {open && (
        <div className="media-picker__panel">
          {loading ? (
            <p className="media-picker__note">Loading…</p>
          ) : filterMedia(items, 'all', '', KINDS[kind]).length === 0 ? (
            <p className="media-picker__note">No {kind === 'any' ? 'files' : `${kind}s`} in the library yet. Upload {NOUN[kind]} or type its address.</p>
          ) : (
            <>
            <div className="media-picker__tools">
              <MediaKindFilter items={filterMedia(items, 'all', '', KINDS[kind])} value={filter} onChange={setFilter} kinds={KINDS[kind]} />
              <input type="search" className="media-picker__search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" aria-label="Search the media library" />
            </div>
            <div className="media-picker__grid">
              {filterMedia(items, filter, query, KINDS[kind]).map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className="media-picker__tile"
                  aria-pressed={m.cdn_url === value}
                  title={m.alt_text || m.filename}
                  onClick={() => {
                    onChange(m.cdn_url);
                    setOpen(false);
                  }}
                >
                  <MediaThumb item={m} size={120} />
                  {mediaKind(m) !== 'image' && <span className="media-picker__name">{m.filename}</span>}
                </button>
              ))}
            </div>
            </>
          )}
        </div>
      )}

      <style>{`
        .media-picker { display: grid; gap: 6px; min-width: 0; }
        .media-picker__row { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
        .media-picker__input { flex: 1; min-width: 0; width: 100%; padding: .4rem .6rem; border-radius: 6px; font-size: .85rem; }
        .media-picker--light .media-picker__input { background: #fff; color: var(--color-text); border: 1px solid var(--color-border); }
        .media-picker--dark .media-picker__input { background: #1f1f23; color: #fafafa; border: 1px solid #3a3a42; }
        .media-picker__btn { display: inline-flex; align-items: center; padding: .3rem .6rem; font-size: .8rem; border-radius: 5px; cursor: pointer; }
        .media-picker--light .media-picker__btn { background: #fff; color: var(--color-text); border: 1px solid var(--color-border); }
        .media-picker--dark .media-picker__btn { background: #27272a; color: #f4f4f5; border: 1px solid #52525b; }
        .media-picker__btn:focus-visible, .media-picker__tile:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
        .media-picker__btn:focus-within { outline: 2px solid #818cf8; outline-offset: 2px; }
        .media-picker__file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
        .media-picker__preview { max-height: 80px; max-width: 100%; width: auto; border-radius: 6px; border: 1px solid #52525b; }
        .media-picker__error { margin: 0; font-size: .8rem; color: ${theme === 'dark' ? '#fca5a5' : '#b91c1c'}; }
        .media-picker__panel { padding: .75rem; border-radius: .5rem; max-height: 280px; overflow-y: auto; }
        .media-picker--light .media-picker__panel { background: var(--color-surface); border: 1px solid var(--color-border); }
        .media-picker--dark .media-picker__panel { background: #18181b; border: 1px solid #3a3a42; }
        .media-picker__note { margin: 0; font-size: .85rem; }
        .media-picker--light .media-picker__note { color: var(--color-text-muted); }
        .media-picker--dark .media-picker__note { color: #d4d4d8; }
        .media-picker__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: .5rem; }
        .media-picker__tile { padding: 0; border: 2px solid transparent; background: #e4e4e7; border-radius: .375rem; overflow: hidden; cursor: pointer; }
        .media-picker__tile:hover, .media-picker__tile[aria-pressed="true"] { border-color: #818cf8; }
        .media-picker__tile { display: grid; gap: 2px; text-align: start; color: inherit; }
        .media-picker__name { padding: 2px 4px 4px; font-size: .7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .media-picker--dark .media-picker__tile { background: #27272a; }
        .media-picker__tools { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .5rem; }
        .media-picker__search { flex: 1; min-width: 8rem; padding: .3rem .5rem; border-radius: 6px; font-size: .8rem; }
        .media-picker--light .media-picker__search { background: #fff; color: var(--color-text); border: 1px solid var(--color-border); }
        .media-picker--dark .media-picker__search { background: #1f1f23; color: #fafafa; border: 1px solid #3a3a42; }
        .media-picker__chosen { max-width: 100%; max-height: 120px; width: auto; border-radius: 6px; border: 1px solid #52525b; }
        .media-picker__file-chosen { display: flex; gap: .5rem; align-items: center; font-size: .8rem; }
        .media-picker__file-chosen .mthumb { width: 48px; }
        ${mediaThumbStyles}
      `}</style>
    </div>
  );
}

/** The chosen file: an image or a playable video, or the file's thumbnail and name. */
function Selected({ value, items, kind }: { value: string; items: Media[]; kind: PickerKind }) {
  const item = items.find((m) => m.cdn_url === value);
  const shown = item ? mediaKind(item) : kind === 'video' || /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(value) ? 'video' : kind === 'image' || /\.(png|jpe?g|gif|webp|avif|svg)(?:$|[?#])/i.test(value) ? 'image' : 'other';
  if (shown === 'image') return <img className="media-picker__chosen" src={value} alt="" />;
  if (shown === 'video') return <video className="media-picker__chosen" src={value} controls muted playsInline preload="metadata" />;
  return item ? <div className="media-picker__file-chosen"><MediaThumb item={item} size={48} /><span>{item.filename}</span></div> : null;
}
