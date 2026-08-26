import { useEffect, useRef, useState } from 'react';
import type { Media } from '@typeroll/shared';
import MediaDetail from './MediaDetail';

interface UploadState {
  id: string;
  filename: string;
  progress: number;      // 0-100
  cdnUrl?: string;
  error?: string;
}

interface Props {
  siteId: string;
  initialItems: Media[];
  /** When true, clicking an item copies its URL to the clipboard. */
  selectable?: boolean;
  /** Called when an item is selected (used by MediaPicker). */
  onSelect?: (item: Media) => void;
}

export default function MediaLibrary({ siteId, initialItems, selectable, onSelect }: Props) {
  const [items, setItems] = useState<Media[]>(initialItems);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ enabled: boolean; reason?: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeItem = activeId ? items.find((m) => m.id === activeId) ?? null : null;

  // Pre-flight check on mount so users see the disabled state before they
  // try to drop a file and get a tiny per-row error they might miss.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sites/${siteId}/media/upload-status`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setUploadStatus(data);
      })
      .catch(() => {
        if (!cancelled) setUploadStatus({ enabled: false, reason: 'Could not reach the upload-status endpoint.' });
      });
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  // Drag/drop listener on the whole page so the user can drop anywhere.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (files && files.length) void uploadFiles(Array.from(files));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  async function uploadFiles(files: File[]) {
    const queue = files.map((f) => ({
      id: `up-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: f.name,
      progress: 0,
      file: f,
    }));
    setUploads((u) => [...u, ...queue.map(({ file: _, ...rest }) => rest)]);

    const newlyUploaded: Media[] = [];
    await Promise.all(
      queue.map(async (q) => {
        try {
          const uploaded = await uploadOne(siteId, q.file, (pct) => {
            setUploads((u) => u.map((x) => (x.id === q.id ? { ...x, progress: pct } : x)));
          });
          setUploads((u) => u.map((x) => (x.id === q.id ? { ...x, progress: 100, cdnUrl: uploaded.cdn_url } : x)));
          newlyUploaded.push(uploaded);
          // Remove from upload list after a beat
          window.setTimeout(() => {
            setUploads((u) => u.filter((x) => x.id !== q.id));
          }, 1200);
        } catch (e) {
          setUploads((u) =>
            u.map((x) =>
              x.id === q.id ? { ...x, error: e instanceof Error ? e.message : 'Failed' } : x
            )
          );
        }
      })
    );

    if (newlyUploaded.length) {
      setItems((cur) => [...newlyUploaded, ...cur]);
    }
  }

  function copy(url: string) {
    navigator.clipboard?.writeText(url);
  }

  return (
    <div className="media">
      {uploadStatus && !uploadStatus.enabled && (
        <div className="media__alert" role="alert">
          <div className="media__alert-icon" aria-hidden>⚠</div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Media uploads are disabled</div>
            <div className="text-sm">{uploadStatus.reason}</div>
            <div className="text-sm muted" style={{ marginTop: 6 }}>
              Set these in <code>packages/portal/.env</code> (or the hosting platform's env vars in production), then restart the dev server.
            </div>
          </div>
        </div>
      )}
      {dragOver && (
        <div className="media__overlay">
          <div className="media__overlay-inner">
            <div style={{ fontSize: 48 }}>📥</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.5rem' }}>
              Drop to upload
            </div>
          </div>
        </div>
      )}

      <div className="media__toolbar">
        <button className="btn" onClick={() => inputRef.current?.click()}>
          + Upload files
        </button>
        <span className="muted text-sm">— or drag and drop anywhere on the page</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length) void uploadFiles(Array.from(files));
            e.target.value = '';
          }}
        />
      </div>

      {uploads.length > 0 && (
        <div className="media__uploads">
          {uploads.map((u) => (
            <div key={u.id} className={`media__upload ${u.error ? 'media__upload--error' : ''}`}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm" style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.filename}</div>
                {!u.error && (
                  <div className="media__bar">
                    <div className="media__bar-fill" style={{ width: `${u.progress}%`, background: 'var(--color-primary)' }} />
                  </div>
                )}
                {u.error && (
                  <div className="media__upload-error">
                    <strong>Upload failed.</strong> {u.error}
                  </div>
                )}
              </div>
              <div className="media__upload-status">
                {u.error ? '⚠' : u.progress === 100 ? '✓' : `${Math.round(u.progress)}%`}
              </div>
              {u.error && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setUploads((cur) => cur.filter((x) => x.id !== u.id))}
                  aria-label="Dismiss error"
                  title="Dismiss"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
          <div style={{ fontSize: 36 }}>🖼️</div>
          <p className="muted" style={{ marginTop: '0.75rem' }}>No media yet. Drop files anywhere or click upload.</p>
        </div>
      ) : (
        <div className="media__grid">
          {items.map((m) => (
            <div key={m.id} className="media__item">
              <button
                type="button"
                className="media__item-preview"
                onClick={() => (selectable && onSelect ? onSelect(m) : setActiveId(m.id))}
                title={selectable ? 'Select' : 'Open details'}
              >
                {m.mime_type?.startsWith('image') ? (
                  <img src={m.cdn_url} alt={m.alt_text ?? m.filename} loading="lazy" />
                ) : (
                  <div className="media__placeholder">{(m.mime_type ?? 'file').split('/')[1] ?? 'file'}</div>
                )}
              </button>
              <div className="media__meta">
                <div className="text-sm" title={m.filename} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.filename}</div>
                <div className="row" style={{ gap: 4, marginTop: 4 }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => copy(m.cdn_url)} title="Copy URL">📋</button>
                  {selectable ? (
                    <button className="btn btn--sm" onClick={() => onSelect?.(m)}>Select</button>
                  ) : (
                    <button className="btn btn--ghost btn--sm" onClick={() => setActiveId(m.id)} title="Open details">Edit</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeItem && !selectable && (
        <MediaDetail
          siteId={siteId}
          item={activeItem}
          onClose={() => setActiveId(null)}
          onUpdated={(next) => setItems((cur) => cur.map((m) => (m.id === next.id ? next : m)))}
          onDeleted={() => {
            setItems((cur) => cur.filter((m) => m.id !== activeId));
            setActiveId(null);
          }}
        />
      )}

      <style>{styles}</style>
    </div>
  );
}

async function uploadOne(
  siteId: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<Media> {
  // 1. Request a signed URL.
  const presign = await fetch(`/api/sites/${siteId}/media/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    }),
  });
  const presignData = await presign.json();
  if (!presign.ok) throw new Error(presignData.error ?? 'Could not get upload URL');

  // 2. PUT to R2 with XHR so we get progress events.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', presignData.uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });

  // 3. Finalize: apply immutable Cache-Control to the R2 original and
  //    generate AVIF/WebP responsive variants. Best-effort — without it
  //    the image works but Lighthouse will flag both cache lifetimes and
  //    image delivery. We don't block the upload UX on failure (the user
  //    can re-run via the bulk finalize endpoint later).
  if (presignData.finalizeUrl) {
    try {
      const finalize = await fetch(presignData.finalizeUrl, { method: 'POST' });
      if (!finalize.ok) {
        const body = await finalize.text().catch(() => '');
        console.warn(`[media-finalize] ${file.name} finalize returned ${finalize.status}: ${body}`);
      }
    } catch (e) {
      console.warn(`[media-finalize] ${file.name} finalize threw:`, e);
    }
  }

  // 4. The upload-url endpoint already pre-registered a media doc. We don't
  // get its id back from the signed-URL call (by design — keeps the surface
  // tiny). Build a local Media record for the optimistic UI.
  return {
    id: `local-${Date.now()}`,
    filename: file.name,
    cdn_url: presignData.cdnUrl,
    mime_type: file.type,
    size_bytes: file.size,
    created_at: new Date().toISOString(),
  };
}

const styles = `
.media__overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(15,23,42,0.6);
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.media__overlay-inner {
  background: var(--color-surface);
  border: 2px dashed var(--color-primary);
  border-radius: 1rem;
  padding: 3rem 4rem;
  text-align: center;
  color: var(--color-text);
}
.media__toolbar {
  display: flex; align-items: center; gap: 0.75rem;
  margin-bottom: 1rem;
}
.media__uploads {
  display: flex; flex-direction: column; gap: 0.5rem;
  margin-bottom: 1rem;
}
.media__upload {
  display: flex; align-items: center; gap: 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
}
.media__upload--error {
  background: color-mix(in srgb, var(--color-danger) 6%, var(--color-surface));
  border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-border));
}
.media__upload-error {
  margin-top: 4px;
  color: var(--color-danger);
  font-size: 0.85rem;
  line-height: 1.35;
}
.media__upload-status {
  flex-shrink: 0;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
  min-width: 2rem;
  text-align: right;
}
.media__upload--error .media__upload-status { color: var(--color-danger); font-size: 1.1rem; }
.media__alert {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  padding: 1rem 1.1rem;
  margin-bottom: 1rem;
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
  border: 1px solid color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
  border-radius: 0.6rem;
}
.media__alert-icon {
  width: 1.75rem; height: 1.75rem;
  display: grid; place-items: center;
  background: var(--color-accent);
  color: var(--color-background);
  border-radius: 999px;
  font-size: 0.95rem;
  font-weight: 700;
  flex-shrink: 0;
}
.media__alert code {
  background: var(--color-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.85em;
}
.media__bar {
  margin-top: 4px;
  height: 4px;
  background: var(--color-bg);
  border-radius: 999px;
  overflow: hidden;
}
.media__bar-fill { height: 100%; transition: width 0.2s; }
.media__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
}
.media__item {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow: hidden;
  transition: border-color 120ms ease;
}
.media__item:hover { border-color: color-mix(in srgb, var(--color-text) 25%, var(--color-border)); }
.media__item-preview {
  all: unset; display: block; cursor: pointer;
  width: 100%;
}
.media__item-preview img, .media__item-preview .media__placeholder { width: 100%; }
.media__item img {
  width: 100%; aspect-ratio: 1; object-fit: cover;
  display: block;
}
.media__placeholder {
  width: 100%; aspect-ratio: 1;
  background: var(--color-bg);
  display: flex; align-items: center; justify-content: center;
  color: var(--color-text-muted); text-transform: uppercase; font-size: 0.75rem;
}
.media__meta { padding: 0.5rem 0.625rem; }
`;
