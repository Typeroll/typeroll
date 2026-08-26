import { useEffect, useRef, useState } from 'react';
import type { SiteVersion } from '@typeroll/shared';

interface Props {
  siteId: string;
  versions: SiteVersion[];
  currentVersionId: string;
}

interface ChangeSet { added: string[]; modified: string[]; deleted: string[] }
interface VersionDiff {
  pages: ChangeSet;
  partials: ChangeSet;
  redirects: ChangeSet;
  collections: ChangeSet;
  collectionItems: Record<string, ChangeSet>;
  settings: 'unchanged' | 'modified';
  totalChanges: number;
}

type SyncAction = 'promote' | 'reset';

function setCookieAndReload(versionId: string) {
  document.cookie = `typeroll_version=${encodeURIComponent(versionId)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  window.location.reload();
}

function changeCount(c: ChangeSet): number {
  return c.added.length + c.modified.length + c.deleted.length;
}

export default function VersionPicker({ siteId, versions, currentVersionId }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncAction, setSyncAction] = useState<SyncAction | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const current = versions.find((v) => v.id === currentVersionId) ?? versions[0];

  useEffect(() => {
    if (!open || syncAction) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, syncAction]);

  async function createBranch() {
    const name = window.prompt(
      'Name this branch (e.g. "Spring 2026 redesign", "Pricing test").\nIt reads through the current version for anything you don\'t change, and is robots-blocked.',
    );
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, base: currentVersionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to create branch');
      setCookieAndReload(data.version.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setCreating(false);
    }
  }

  async function deleteCurrent() {
    if (!current || current.kind === 'main') return;
    if (!window.confirm(`Delete branch "${current.name}"? This permanently removes all its content. Main is unaffected.`)) return;
    const res = await fetch(`/api/sites/${siteId}/versions/${current.id}`, { method: 'DELETE' });
    if (res.ok) setCookieAndReload('main');
    else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Failed to delete');
    }
  }

  return (
    <>
      <div className="vp" ref={ref}>
        <button
          type="button"
          className={`vp__trigger vp__trigger--${current?.kind ?? 'main'}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="vp__label">Version</span>
          <span className="vp__current">
            <span className={`vp__pip vp__pip--${current?.kind ?? 'main'}`} aria-hidden />
            <span className="vp__name">{current?.name ?? 'Main'}</span>
            <svg className="vp__chev" width="11" height="11" viewBox="0 0 12 12" aria-hidden>
              <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          {current?.kind === 'branch' && current.robots_blocked && (
            <span className="vp__meta">🔒 robots-blocked</span>
          )}
        </button>

        {open && (
          <div className="vp__menu" role="listbox" aria-label="Switch version">
            <div className="vp__menu-label">Versions</div>
            {versions.map((v) => (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={v.id === currentVersionId}
                className={`vp__item ${v.id === currentVersionId ? 'vp__item--active' : ''}`}
                onClick={() => (v.id === currentVersionId ? setOpen(false) : setCookieAndReload(v.id))}
              >
                <span className={`vp__pip vp__pip--${v.kind}`} aria-hidden />
                <span className="vp__item-body">
                  <span className="vp__item-name">{v.name}</span>
                  <span className="vp__item-meta">
                    {v.kind === 'main' ? 'production' : v.robots_blocked ? 'branch · robots-blocked' : 'branch'}
                  </span>
                </span>
                {v.id === currentVersionId && (
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                    <path d="M3 7.5l2.8 2.8L11 5" stroke="currentColor" strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))}
            <button
              type="button"
              className="vp__new"
              onClick={createBranch}
              disabled={creating}
            >
              <span className="vp__new-icon" aria-hidden>+</span>
              {creating ? 'Cloning…' : 'New branch'}
            </button>
            {current?.kind === 'branch' && (
              <>
                <button type="button" className="vp__action" onClick={() => setSyncAction('promote')}>
                  <span className="vp__action-icon" aria-hidden>↑</span>
                  Promote to main…
                </button>
                <button type="button" className="vp__action" onClick={() => setSyncAction('reset')}>
                  <span className="vp__action-icon" aria-hidden>↺</span>
                  Reset from main…
                </button>
                <button type="button" className="vp__delete" onClick={deleteCurrent}>
                  <span className="vp__delete-icon" aria-hidden>🗑</span>
                  Delete this branch
                </button>
              </>
            )}
            {error && <div className="vp__error">{error}</div>}
          </div>
        )}
      </div>

      {syncAction && current?.kind === 'branch' && (
        <SyncDialog
          siteId={siteId}
          branch={current}
          action={syncAction}
          onClose={() => setSyncAction(null)}
        />
      )}
    </>
  );
}

interface SyncDialogProps {
  siteId: string;
  branch: SiteVersion;
  action: SyncAction;
  onClose: () => void;
}

function SyncDialog({ siteId, branch, action, onClose }: SyncDialogProps) {
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/sites/${siteId}/versions/${branch.id}/diff`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to load diff');
        setDiff(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load diff');
      }
    })();
  }, [siteId, branch.id]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/versions/${branch.id}/${action}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      if (action === 'reset') {
        // After reset the branch is a clean passthrough; force-reload so the
        // editor sees the now-resolved-from-main content.
        window.location.reload();
      } else {
        // After promote, main has the branch's content. Stay on the branch
        // (the user might want to keep working) but reload so things settle.
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  }

  const heading = action === 'promote' ? `Promote “${branch.name}” to main` : `Reset “${branch.name}” from main`;
  const intent = action === 'promote'
    ? "Every override and tombstone on this branch will be applied to main. The branch itself is left in place — you can keep working on it or delete it from the picker. Main will deploy with this content on its next build."
    : "Every override and tombstone on this branch will be discarded. The branch becomes a pure passthrough to main again. Revision history on the branch is preserved.";

  return (
    <div className="vpd__backdrop" onClick={onClose}>
      <div className="vpd" role="dialog" aria-modal="true" aria-label={heading} onClick={(e) => e.stopPropagation()}>
        <header className="vpd__head">
          <h2 className="vpd__title">{heading}</h2>
          <button type="button" className="vpd__close" aria-label="Close" onClick={onClose}>×</button>
        </header>

        <p className="vpd__intent">{intent}</p>

        <div className="vpd__diff">
          {!diff && !error && <div className="vpd__loading">Computing diff…</div>}
          {error && <div className="vpd__error">{error}</div>}
          {diff && diff.totalChanges === 0 && (
            <div className="vpd__empty">This branch has no changes vs main yet.</div>
          )}
          {diff && diff.totalChanges > 0 && (
            <table className="vpd__table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th className="vpd__col-num">Added</th>
                  <th className="vpd__col-num">Modified</th>
                  <th className="vpd__col-num">Deleted</th>
                </tr>
              </thead>
              <tbody>
                <DiffRow label="Pages" c={diff.pages} />
                <DiffRow label="Global blocks" c={diff.partials} />
                <DiffRow label="Redirects" c={diff.redirects} />
                <DiffRow label="Collections" c={diff.collections} />
                {Object.entries(diff.collectionItems).map(([name, c]) => (
                  <DiffRow key={name} label={`Items: ${name}`} c={c} />
                ))}
                {diff.settings === 'modified' && (
                  <tr>
                    <td>Site settings</td>
                    <td className="vpd__col-num">—</td>
                    <td className="vpd__col-num">1</td>
                    <td className="vpd__col-num">—</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <footer className="vpd__foot">
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={`btn ${action === 'reset' ? 'btn--danger' : ''}`}
            onClick={confirm}
            disabled={busy || !diff || diff.totalChanges === 0}
          >
            {busy ? 'Working…' : action === 'promote' ? `Promote ${diff?.totalChanges ?? 0} change${diff?.totalChanges === 1 ? '' : 's'}` : `Discard ${diff?.totalChanges ?? 0} change${diff?.totalChanges === 1 ? '' : 's'}`}
          </button>
        </footer>

        <style>{`
          .vpd__backdrop {
            position: fixed; inset: 0;
            background: rgba(8,8,10,0.55);
            z-index: 60;
            display: grid; place-items: center;
            padding: 1.5rem;
            animation: vpd-in 140ms ease;
          }
          @keyframes vpd-in { from { opacity: 0 } to { opacity: 1 } }
          .vpd {
            background: var(--color-surface);
            color: var(--color-text);
            border-radius: 0.85rem;
            box-shadow: 0 30px 80px -20px rgba(0,0,0,0.4);
            max-width: 640px;
            width: 100%;
            max-height: 80vh;
            display: flex; flex-direction: column;
            overflow: hidden;
          }
          .vpd__head {
            display: flex; align-items: center; justify-content: space-between;
            padding: 1.1rem 1.25rem 0.85rem;
            border-bottom: 1px solid var(--color-border);
          }
          .vpd__title {
            font-family: var(--font-display);
            font-style: italic;
            font-weight: 500;
            font-size: 1.35rem;
            letter-spacing: -0.01em;
          }
          .vpd__close {
            background: none; border: 0;
            color: var(--color-text-muted);
            font-size: 1.5rem; line-height: 1; cursor: pointer;
            padding: 4px 8px;
          }
          .vpd__close:hover { color: var(--color-text); }
          .vpd__intent {
            padding: 0.85rem 1.25rem;
            color: var(--color-text-muted);
            font-size: 0.92rem;
            border-bottom: 1px solid var(--color-border);
          }
          .vpd__diff {
            padding: 1rem 1.25rem;
            overflow-y: auto;
            flex: 1;
          }
          .vpd__loading, .vpd__empty {
            padding: 1.5rem;
            text-align: center;
            color: var(--color-text-muted);
          }
          .vpd__error {
            padding: 1rem;
            background: rgba(220,38,38,0.06);
            border: 1px solid rgba(220,38,38,0.18);
            border-radius: 6px;
            color: var(--color-danger);
          }
          .vpd__table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.92rem;
          }
          .vpd__table th, .vpd__table td {
            padding: 0.5rem 0.75rem;
            text-align: left;
            border-bottom: 1px solid var(--color-border);
          }
          .vpd__table th {
            font-weight: 500;
            font-size: 0.78rem;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--color-text-muted);
          }
          .vpd__col-num { text-align: right; font-variant-numeric: tabular-nums; width: 5.5rem; }
          .vpd__foot {
            display: flex; justify-content: flex-end; gap: 0.75rem;
            padding: 0.9rem 1.25rem;
            border-top: 1px solid var(--color-border);
            background: var(--color-bg);
          }
          .vp__action {
            all: unset;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 8px 9px;
            color: var(--sb-text-muted);
            font-size: 0.82rem;
            font-weight: 500;
            border-radius: 7px;
            width: 100%;
            box-sizing: border-box;
            border-top: 1px dashed var(--sb-border);
          }
          .vp__action:first-of-type { margin-top: 3px; }
          .vp__action:hover { background: var(--sb-bg-hover); color: var(--sb-text); }
          .vp__action-icon {
            width: 16px; height: 16px;
            display: grid; place-items: center;
            border: 1px solid var(--sb-text-dim);
            border-radius: 5px;
            color: var(--sb-text-dim);
            font-size: 11px;
          }
          .vp__action:hover .vp__action-icon { color: var(--sb-text); border-color: var(--sb-text); }
        `}</style>
      </div>
    </div>
  );
}

function DiffRow({ label, c }: { label: string; c: ChangeSet }) {
  if (changeCount(c) === 0) return null;
  return (
    <tr>
      <td>{label}</td>
      <td className="vpd__col-num">{c.added.length || '—'}</td>
      <td className="vpd__col-num">{c.modified.length || '—'}</td>
      <td className="vpd__col-num">{c.deleted.length || '—'}</td>
    </tr>
  );
}
