// "Review changes" overlay — the trust layer of the buffer model. Shows
// the SAVED page and the DRAFT side by side (same preview renderer the
// editor uses; the ?embed=1 view overlays working copies, the plain view
// does not) plus the structured diff from /pages/{id}/changes. This is how
// a human audits what an agent (or a colleague, or past-them) left in the
// draft before hitting Save.

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { BlockChange } from '@typeroll/shared';

interface Props {
  siteId: string;
  pageId: string;
  /** Plain preview URL (saved view). The draft view appends embed=1. */
  previewUrl: string;
  onClose: () => void;
}

interface Summary {
  has_working_copy: boolean;
  meta_changed: string[];
  block_changes: BlockChange[];
}

const KIND_LABEL: Record<BlockChange['kind'], { label: string; color: string }> = {
  added: { label: 'Ny', color: '#22c55e' },
  changed: { label: 'Changed', color: '#eab308' },
  moved: { label: 'Flyttad', color: '#818cf8' },
  removed: { label: 'Borttagen', color: '#f87171' },
};

export default function ReviewChanges({ siteId, pageId, previewUrl, onClose }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leftRef = useRef<HTMLIFrameElement>(null);
  const rightRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sites/${siteId}/pages/${pageId}/changes`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load changes (${r.status})`);
        return r.json() as Promise<Summary>;
      })
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [siteId, pageId]);

  const leftCanvasId = `review-${siteId}-${pageId}-saved`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  const rightCanvasId = `review-${siteId}-${pageId}-draft`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);

  // Scroll sync through the opaque-origin bridge. A mirrored scroll produces
  // its own event, so expected values suppress the echo.
  useEffect(() => {
    let expectedLeft: number | null = null;
    let expectedRight: number | null = null;
    const send = (frame: HTMLIFrameElement | null, canvasId: string, y: number) => frame?.contentWindow?.postMessage({
      channel: 'typeroll.editor-canvas', version: 1, canvas_id: canvasId, action: 'scroll', scroll_y: y,
    }, '*');
    const receive = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.channel !== 'typeroll.editor-canvas' || data.version !== 1 || data.type !== 'scroll' || typeof data.scroll_y !== 'number') return;
      if (event.source === leftRef.current?.contentWindow && data.canvas_id === leftCanvasId) {
        if (expectedLeft !== null && Math.abs(expectedLeft - data.scroll_y) < 1) { expectedLeft = null; return; }
        expectedRight = data.scroll_y; send(rightRef.current, rightCanvasId, data.scroll_y);
      } else if (event.source === rightRef.current?.contentWindow && data.canvas_id === rightCanvasId) {
        if (expectedRight !== null && Math.abs(expectedRight - data.scroll_y) < 1) { expectedRight = null; return; }
        expectedLeft = data.scroll_y; send(leftRef.current, leftCanvasId, data.scroll_y);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [leftCanvasId, rightCanvasId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const savedUrl = previewUrl + (previewUrl.includes('?') ? '&' : '?') + `canvas=${encodeURIComponent(leftCanvasId)}`;
  const draftUrl = previewUrl + (previewUrl.includes('?') ? '&' : '?') + `embed=1&canvas=${encodeURIComponent(rightCanvasId)}`;
  const changes = summary?.block_changes ?? [];

  return (
    <div style={overlay} role="dialog" aria-label="Review changes">
      <header style={header}>
        <strong style={{ fontSize: '0.95rem' }}>Review changes</strong>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
          {error && <span style={{ color: '#f87171', fontSize: '.8rem' }}>{error}</span>}
          {summary && !summary.has_working_copy && (
            <span style={{ opacity: 0.7, fontSize: '.8rem' }}>No unsaved changes.</span>
          )}
          {summary?.meta_changed.map((f) => (
            <span key={`m-${f}`} style={chip('#38bdf8')}>meta: {f}</span>
          ))}
          {changes.map((c, i) => (
            <span key={i} style={chip(KIND_LABEL[c.kind].color)} title={c.fields?.join(', ')}>
              {KIND_LABEL[c.kind].label}: {c.name || c.type.replace(/^core\//, '')}
              {c.kind === 'changed' && c.fields?.length ? ` (${c.fields.join(', ')})` : ''}
            </span>
          ))}
        </div>
        <button type="button" onClick={onClose} style={closeBtn} title="Close (Esc)">
          <X size={16} />
        </button>
      </header>
      <div style={panes}>
        <div style={pane}>
          <div style={paneLabel}>Saved</div>
          <iframe ref={leftRef} src={savedUrl} title="Saved version" style={frame} />
        </div>
        <div style={pane}>
          <div style={{ ...paneLabel, color: '#fbbf24' }}>Utkast (osparat)</div>
          <iframe ref={rightRef} src={draftUrl} title="Utkast" style={frame} />
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, background: '#111114',
  display: 'flex', flexDirection: 'column',
};
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #2a2a30', color: '#fafafa', background: '#18181b',
};
const chip = (color: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', padding: '0.1rem 0.5rem',
  borderRadius: 999, fontSize: '.72rem', border: `1px solid ${color}`,
  color, whiteSpace: 'nowrap',
});
const closeBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: 6, cursor: 'pointer',
  background: '#1f1f23', color: '#d4d4d8', border: '1px solid #2a2a30',
};
const panes: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0, gap: 1, background: '#2a2a30' };
const pane: React.CSSProperties = {
  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#111114',
};
const paneLabel: React.CSSProperties = {
  padding: '0.3rem 0.6rem', fontSize: '.72rem', textTransform: 'uppercase',
  letterSpacing: '0.05em', color: '#a1a1aa', background: '#18181b',
};
const frame: React.CSSProperties = { flex: 1, border: 'none', background: '#fff', width: '100%' };
