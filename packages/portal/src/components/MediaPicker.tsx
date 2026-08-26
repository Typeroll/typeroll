import { useEffect, useState } from 'react';
import type { Media } from '@typeroll/shared';

interface Props {
  value: string;
  onChange: (url: string) => void;
  siteId: string;
}

// Compact field used inside other forms (collection items, page editor)
// to pick or paste an image URL.
export default function MediaPicker({ value, onChange, siteId }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open || items.length > 0) return;
    setLoading(true);
    fetch(`/api/sites/${siteId}/media`)
      .then((r) => r.json())
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, [open, items.length, siteId]);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const presign = await fetch(`/api/sites/${siteId}/media/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });
      const data = await presign.json();
      if (!presign.ok) throw new Error(data.error ?? 'Failed');
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
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="media-picker">
      <div className="row">
        <input
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://cdn.example.com/…"
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpen((o) => !o)}>
          Library
        </button>
        <label className="btn btn--secondary btn--sm" style={{ cursor: 'pointer' }}>
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadFile(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {value && (
        <div style={{ marginTop: 8 }}>
          <img src={value} alt="" style={{ maxHeight: 80, borderRadius: 6, border: '1px solid var(--color-border)' }} />
        </div>
      )}

      {open && (
        <div className="media-picker__panel">
          {loading ? (
            <div className="muted text-sm">Loading…</div>
          ) : items.length === 0 ? (
            <div className="muted text-sm">No media yet — upload or paste a URL.</div>
          ) : (
            <div className="media-picker__grid">
              {items.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className="media-picker__tile"
                  onClick={() => {
                    onChange(m.cdn_url);
                    setOpen(false);
                  }}
                >
                  <img src={m.cdn_url} alt={m.alt_text ?? m.filename} loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        .media-picker__panel {
          margin-top: 8px;
          padding: 0.75rem;
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          max-height: 280px;
          overflow-y: auto;
        }
        .media-picker__grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
          gap: 0.5rem;
        }
        .media-picker__tile {
          padding: 0; border: 1px solid var(--color-border);
          background: var(--color-bg); border-radius: 0.375rem; overflow: hidden;
          cursor: pointer;
        }
        .media-picker__tile:hover { border-color: var(--color-primary); }
        .media-picker__tile img {
          width: 100%; aspect-ratio: 1; object-fit: cover; display: block;
        }
      `}</style>
    </div>
  );
}
