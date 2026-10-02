import { useEffect, useState } from 'react';
import type { Media } from '@typeroll/shared';

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
}

// Compact field used inside other forms (page editor inspector, block type
// preview data) to pick an image from the media library, upload one, or
// type an address.
export default function MediaPicker({ value, onChange, siteId, id, label = 'Image address', theme = 'light' }: Props) {
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
      await fetch(data.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      // Finalize: cache headers + AVIF/WebP variants. Best-effort.
      if (data.finalizeUrl) {
        try {
          await fetch(data.finalizeUrl, { method: 'POST' });
        } catch (e) {
          console.warn('[media-finalize]', e);
        }
      }
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
          aria-label={id ? undefined : label}
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
        <label className="media-picker__btn">
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            accept="image/*"
            className="media-picker__file"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadFile(f);
              e.target.value = '';
            }}
          />
        </label>
        {value && <button type="button" className="media-picker__btn" onClick={() => onChange('')}>Remove</button>}
      </div>

      {value && <img className="media-picker__preview" src={value} alt="" />}
      {error && <p role="alert" className="media-picker__error">{error}</p>}

      {open && (
        <div className="media-picker__panel">
          {loading ? (
            <p className="media-picker__note">Loading…</p>
          ) : items.length === 0 ? (
            <p className="media-picker__note">No media yet. Upload an image or type its address.</p>
          ) : (
            <div className="media-picker__grid">
              {items.map((m) => (
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
                  <img src={m.cdn_url} alt={m.alt_text || m.filename} loading="lazy" />
                </button>
              ))}
            </div>
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
        .media-picker__tile img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
      `}</style>
    </div>
  );
}
