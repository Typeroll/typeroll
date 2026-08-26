import { useEffect, useState } from 'react';
import type { Revision } from '@typeroll/shared';

interface Props {
  /** API endpoint that returns { revisions: Revision[] } on GET and accepts { revId } on POST. */
  endpoint: string;
  /** Where to navigate after a successful restore (full reload so the editor re-fetches). */
  reloadOnRestore?: boolean;
  /**
   * Builds the preview URL for a given revision id. When omitted, the
   * Preview button is hidden (e.g. for partials/items where snapshot
   * preview isn't wired up yet).
   */
  previewUrlFor?: (revId: string) => string;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return iso;
  const diff = Date.now() - t;
  const min = 60_000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)} min ago`;
  if (diff < day) return `${Math.floor(diff / hr)} h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} d ago`;
  return new Date(t).toLocaleDateString();
}

export default function HistoryPanel({ endpoint, reloadOnRestore = true, previewUrlFor }: Props) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch(endpoint);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load history');
      setRevisions(data.revisions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    }
  }

  useEffect(() => {
    load();
  }, [endpoint]);

  async function restore(revId: string) {
    if (!confirm('Restore this revision? The current state will be snapshotted to history first, so you can undo.')) return;
    setRestoring(revId);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to restore');
      if (reloadOnRestore) {
        window.location.reload();
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to restore');
      setRestoring(null);
    }
  }

  if (revisions === null && !error) return <div className="hist hist--empty">Loading history…</div>;
  if (error) return <div className="hist hist--error">{error}</div>;
  if (!revisions || revisions.length === 0) {
    return (
      <div className="hist hist--empty">
        <p>No history yet on this branch.</p>
        <p className="muted text-sm">Snapshots are written automatically each time you save. They live per-branch — switching to a different branch shows that branch's history.</p>
      </div>
    );
  }

  return (
    <div className="hist">
      <ul className="hist__list">
        {revisions.map((r) => (
          <li key={r.id} className="hist__row">
            <div className="hist__meta">
              <div className="hist__when">{formatRelative(r.created_at)}</div>
              <div className="hist__by muted text-sm">{r.created_by}{r.note ? ` · ${r.note}` : ''}</div>
            </div>
            <div className="hist__row-actions">
              {previewUrlFor && (
                <a
                  href={previewUrlFor(r.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--ghost btn--sm"
                  title="Open this snapshot in a new tab"
                >
                  Preview ↗
                </a>
              )}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={restoring === r.id}
                onClick={() => restore(r.id)}
              >
                {restoring === r.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted text-sm" style={{ marginTop: '0.75rem' }}>
        Keeping the 100 most recent snapshots per doc per branch. Restoring snapshots the current state first, so you can undo.
      </p>

      <style>{`
        .hist__list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
        .hist__row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 0.55rem 0.7rem;
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          background: var(--color-surface);
        }
        .hist__row-actions { display: inline-flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }
        .hist__meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .hist__when { font-weight: 500; font-size: 0.9rem; }
        .hist__by { font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .hist--empty, .hist--error {
          padding: 1.5rem;
          text-align: center;
          color: var(--color-text-muted);
          border: 1px dashed var(--color-border);
          border-radius: 0.5rem;
        }
        .hist--error { color: var(--color-danger); border-color: var(--color-danger); }
      `}</style>
    </div>
  );
}
