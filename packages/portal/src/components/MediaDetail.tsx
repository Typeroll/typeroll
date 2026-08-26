import { useEffect, useState } from 'react';
import { X, Copy, Trash2, ExternalLink } from 'lucide-react';
import type { Media } from '@typeroll/shared';

interface Props {
  siteId: string;
  item: Media;
  onClose: () => void;
  onUpdated: (next: Media) => void;
  onDeleted: () => void;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';

function bytes(n?: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaDetail({ siteId, item, onClose, onUpdated, onDeleted }: Props) {
  const [draft, setDraft] = useState<Media>(item);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep draft in sync if the parent passes a different item (clicking another
  // thumbnail without closing the drawer first).
  useEffect(() => {
    setDraft(item);
    setStatus('idle');
    setError(null);
  }, [item.id]);

  // Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  function patch<K extends keyof Media>(key: K, value: Media[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/media/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: draft.filename,
          alt_text: draft.alt_text ?? '',
          title: draft.title ?? '',
          caption: draft.caption ?? '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setStatus('saved');
      onUpdated(draft);
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  }

  async function destroy() {
    if (!confirm(`Delete "${item.filename}"? This removes the file from storage and any pages still linking to it will break.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/media/${item.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Delete failed');
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setBusy(false);
    }
  }

  function copy(value: string) {
    navigator.clipboard?.writeText(value);
  }

  const isImage = item.mime_type?.startsWith('image/');
  const dimensions =
    draft.width && draft.height ? `${draft.width} × ${draft.height} px` : '—';

  return (
    <>
      <div className="mdetail__backdrop" onClick={() => !busy && onClose()} aria-hidden />
      <aside className="mdetail" role="dialog" aria-label={`Media: ${item.filename}`}>
        <header className="mdetail__head">
          <button type="button" className="mdetail__close" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
          <div className="mdetail__head-meta">
            <div className="mdetail__head-status">
              {status === 'saving' ? 'Saving…' :
               status === 'saved' ? <span style={{ color: 'var(--color-success)' }}>Saved</span> :
               status === 'error' ? <span style={{ color: 'var(--color-danger)' }}>{error}</span> :
               'Edit details'}
            </div>
          </div>
        </header>

        <div className="mdetail__preview">
          {isImage ? (
            <img
              src={item.cdn_url}
              alt={draft.alt_text ?? draft.filename}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (!draft.width && img.naturalWidth) {
                  patch('width', img.naturalWidth);
                  patch('height', img.naturalHeight);
                }
              }}
            />
          ) : (
            <div className="mdetail__nonimage">
              <div style={{ fontSize: 48 }}>📄</div>
              <div style={{ marginTop: 8, fontWeight: 500 }}>{item.mime_type ?? 'file'}</div>
            </div>
          )}
        </div>

        <div className="mdetail__body">
          <section className="mdetail__section">
            <label className="mdetail__label" htmlFor="md-filename">Filename</label>
            <input
              id="md-filename"
              type="text"
              value={draft.filename}
              onChange={(e) => patch('filename', e.target.value)}
              className="mdetail__input"
            />
            <p className="mdetail__hint">Displayed in the library. The CDN URL doesn't change.</p>
          </section>

          <section className="mdetail__section">
            <label className="mdetail__label" htmlFor="md-alt">Alt text <span className="mdetail__tag">SEO + a11y</span></label>
            <textarea
              id="md-alt"
              rows={2}
              value={draft.alt_text ?? ''}
              onChange={(e) => patch('alt_text', e.target.value)}
              placeholder="Describe what's in the image, for screen readers and search engines."
              className="mdetail__input"
            />
          </section>

          <section className="mdetail__section">
            <label className="mdetail__label" htmlFor="md-title">Title</label>
            <input
              id="md-title"
              type="text"
              value={draft.title ?? ''}
              onChange={(e) => patch('title', e.target.value)}
              placeholder="Optional — shown on hover and in some lightboxes."
              className="mdetail__input"
            />
          </section>

          <section className="mdetail__section">
            <label className="mdetail__label" htmlFor="md-caption">Caption</label>
            <textarea
              id="md-caption"
              rows={2}
              value={draft.caption ?? ''}
              onChange={(e) => patch('caption', e.target.value)}
              placeholder="Optional — rendered under the image when the AI inserts it."
              className="mdetail__input"
            />
          </section>

          <section className="mdetail__section mdetail__meta">
            <dl>
              <div><dt>Dimensions</dt><dd>{dimensions}</dd></div>
              <div><dt>Size</dt><dd>{bytes(draft.size_bytes)}</dd></div>
              <div><dt>Type</dt><dd>{draft.mime_type ?? '—'}</dd></div>
              <div><dt>Uploaded</dt><dd>{draft.created_at ? new Date(draft.created_at).toLocaleString() : '—'}</dd></div>
            </dl>
          </section>

          <section className="mdetail__section">
            <label className="mdetail__label">CDN URL</label>
            <div className="mdetail__url">
              <code title={item.cdn_url}>{item.cdn_url}</code>
              <button type="button" onClick={() => copy(item.cdn_url)} title="Copy URL" className="mdetail__icon-btn">
                <Copy size={14} />
              </button>
              <a href={item.cdn_url} target="_blank" rel="noopener" title="Open in new tab" className="mdetail__icon-btn">
                <ExternalLink size={14} />
              </a>
            </div>
          </section>
        </div>

        <footer className="mdetail__foot">
          <button type="button" className="btn btn--ghost btn--sm mdetail__delete" onClick={destroy} disabled={busy}>
            <Trash2 size={14} /> {busy ? 'Deleting…' : 'Delete'}
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={save} disabled={status === 'saving' || busy}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </footer>

        <style>{`
          .mdetail__backdrop {
            position: fixed; inset: 0; z-index: 90;
            background: rgba(8,8,10,0.4);
            animation: md-fade-in 140ms ease;
          }
          @keyframes md-fade-in { from { opacity: 0 } to { opacity: 1 } }
          .mdetail {
            position: fixed; top: 0; right: 0; bottom: 0; z-index: 100;
            width: min(560px, 100vw);
            background: var(--color-surface);
            box-shadow: -24px 0 60px -12px rgba(0,0,0,0.25);
            display: flex; flex-direction: column;
            animation: md-slide-in 220ms cubic-bezier(.2,.7,.3,1);
          }
          @keyframes md-slide-in {
            from { transform: translateX(100%) }
            to   { transform: translateX(0) }
          }
          .mdetail__head {
            display: flex; align-items: center; gap: 0.75rem;
            padding: 0.9rem 1.1rem;
            border-bottom: 1px solid var(--color-border);
            background: var(--color-surface);
          }
          .mdetail__close {
            background: none; border: 0; padding: 0.25rem; cursor: pointer;
            color: var(--color-text-muted); border-radius: var(--radius-sm);
            display: inline-flex;
          }
          .mdetail__close:hover { color: var(--color-text); background: var(--color-bg); }
          .mdetail__head-meta { flex: 1; }
          .mdetail__head-status { font-size: 0.9rem; color: var(--color-text-muted); }
          .mdetail__preview {
            background: linear-gradient(135deg, #f3f4f6 25%, #e5e7eb 25%, #e5e7eb 50%, #f3f4f6 50%, #f3f4f6 75%, #e5e7eb 75%);
            background-size: 16px 16px;
            display: flex; align-items: center; justify-content: center;
            padding: 1rem;
            min-height: 240px;
            max-height: 40vh;
          }
          .mdetail__preview img {
            max-width: 100%; max-height: calc(40vh - 2rem);
            object-fit: contain;
            box-shadow: 0 4px 14px -4px rgba(0,0,0,0.18);
            border-radius: 4px;
            background: white;
          }
          .mdetail__nonimage { text-align: center; color: var(--color-text-muted); }
          .mdetail__body {
            flex: 1; overflow-y: auto;
            padding: 1.25rem 1.1rem;
            display: flex; flex-direction: column; gap: 1.1rem;
          }
          .mdetail__section { display: flex; flex-direction: column; gap: 0.35rem; }
          .mdetail__label {
            font-size: 0.78rem; font-weight: 600;
            text-transform: uppercase; letter-spacing: 0.06em;
            color: var(--color-text-muted);
            display: inline-flex; align-items: center; gap: 0.5rem;
          }
          .mdetail__tag {
            font-size: 0.62rem; font-weight: 500; padding: 1px 5px;
            background: var(--color-bg); border: 1px solid var(--color-border);
            border-radius: 999px; color: var(--color-text-muted);
            letter-spacing: 0.04em;
          }
          .mdetail__input {
            width: 100%;
            padding: 0.5rem 0.7rem;
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            background: var(--color-bg);
            font: inherit; color: inherit;
            outline: none;
            transition: border-color 120ms ease;
          }
          .mdetail__input:focus { border-color: var(--color-primary); }
          .mdetail__hint {
            font-size: 0.78rem; color: var(--color-text-muted);
            margin: 0;
          }
          .mdetail__meta dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; }
          .mdetail__meta dt { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-muted); margin-bottom: 2px; }
          .mdetail__meta dd { margin: 0; font-size: 0.88rem; font-weight: 500; }
          .mdetail__url {
            display: flex; align-items: center; gap: 0.4rem;
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            background: var(--color-bg);
            padding: 0.35rem 0.5rem;
          }
          .mdetail__url code {
            flex: 1; font-size: 0.76rem;
            overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
            font-family: var(--font-mono);
          }
          .mdetail__icon-btn {
            background: none; border: 0; cursor: pointer;
            color: var(--color-text-muted);
            padding: 0.25rem; border-radius: var(--radius-sm);
            display: inline-flex;
          }
          .mdetail__icon-btn:hover { color: var(--color-text); background: var(--color-surface); text-decoration: none; }
          .mdetail__foot {
            display: flex; align-items: center; gap: 0.6rem;
            padding: 0.85rem 1.1rem;
            border-top: 1px solid var(--color-border);
            background: var(--color-surface);
          }
          .mdetail__delete {
            color: var(--color-danger);
          }
          .mdetail__delete:hover { background: color-mix(in srgb, var(--color-danger) 8%, transparent); }
          @media (max-width: 600px) {
            .mdetail__preview { max-height: 30vh; }
          }
        `}</style>
      </aside>
    </>
  );
}
