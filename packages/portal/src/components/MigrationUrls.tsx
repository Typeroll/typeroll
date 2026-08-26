import { useEffect, useMemo, useState } from 'react';
import type { MigrationUrl } from '@typeroll/shared';

type UrlStatus = 'migrated' | 'redirected' | 'excluded' | 'unhandled';

interface AnalyzedUrl extends MigrationUrl {
  status: UrlStatus;
  target?: string;
}

interface Summary {
  total: number;
  migrated: number;
  redirected: number;
  excluded: number;
  unhandled: number;
}

interface Props {
  siteId: string;
  initial: { urls: AnalyzedUrl[]; summary: Summary };
}

type StatusFilter = 'all' | UrlStatus;

export default function MigrationUrls({ siteId, initial }: Props) {
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<StatusFilter>('unhandled');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Refresh from server (re-runs the classifier against current pages + redirects).
  async function refresh() {
    const res = await fetch(`/api/sites/${siteId}/migration-urls`);
    if (res.ok) setData(await res.json());
  }

  useEffect(() => {
    // Re-classify whenever the user returns to the page (covers the
    // "added a redirect in another tab" case).
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.urls.filter((u) => {
      if (filter !== 'all' && u.status !== filter) return false;
      if (q && !u.path.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.urls, filter, search]);

  async function toggleExcluded(url: AnalyzedUrl) {
    setBusy(url.id);
    try {
      const res = await fetch(`/api/sites/${siteId}/migration-urls/${encodeURIComponent(url.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded: !url.excluded }),
      });
      if (res.ok) await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function addRedirect(url: AnalyzedUrl) {
    const to = window.prompt(`Redirect ${url.path} → ?\n\nEnter the new path (e.g. /services).`, '/');
    if (!to) return;
    setBusy(url.id);
    try {
      // Use the existing redirects form endpoint so behavior matches the
      // Redirects page exactly (de-dupe, normalization, doc id).
      const fd = new FormData();
      fd.set('from_path', url.path);
      fd.set('to_path', to);
      fd.set('status_code', '301');
      await fetch(`/api/sites/${siteId}/redirects`, { method: 'POST', body: fd });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const s = data.summary;

  return (
    <div className="stack">
      <div className="cards-row">
        <SummaryCard label="Total" value={s.total} muted />
        <SummaryCard label="Migrated" value={s.migrated} tone="success" onClick={() => setFilter('migrated')} active={filter === 'migrated'} />
        <SummaryCard label="Redirected" value={s.redirected} tone="info" onClick={() => setFilter('redirected')} active={filter === 'redirected'} />
        <SummaryCard label="Excluded" value={s.excluded} tone="muted" onClick={() => setFilter('excluded')} active={filter === 'excluded'} />
        <SummaryCard label="Unhandled" value={s.unhandled} tone="danger" onClick={() => setFilter('unhandled')} active={filter === 'unhandled'} />
      </div>

      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterChip>
          <FilterChip active={filter === 'unhandled'} onClick={() => setFilter('unhandled')}>Unhandled</FilterChip>
          <FilterChip active={filter === 'migrated'} onClick={() => setFilter('migrated')}>Migrated</FilterChip>
          <FilterChip active={filter === 'redirected'} onClick={() => setFilter('redirected')}>Redirected</FilterChip>
          <FilterChip active={filter === 'excluded'} onClick={() => setFilter('excluded')}>Excluded</FilterChip>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            type="search"
            placeholder="Filter by path"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '0.4rem 0.75rem', border: '1px solid var(--color-border)', borderRadius: 6, minWidth: 200 }}
          />
          <button className="btn btn--secondary btn--sm" onClick={refresh}>Recompute</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="urls-table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Status</th>
              <th>Target</th>
              <th>Sources</th>
              <th style={{ textAlign: 'right' }}>Clicks</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '2rem', textAlign: 'center' }} className="muted">
                  {data.urls.length === 0 ? 'No URLs inventoried yet.' : 'Nothing matches this filter.'}
                </td>
              </tr>
            ) : (
              filtered.map((u) => (
                <tr key={u.id}>
                  <td className="urls-table__path">{u.path}</td>
                  <td><StatusBadge status={u.status} /></td>
                  <td className="urls-table__target">{u.target ?? '—'}</td>
                  <td className="urls-table__sources">
                    {u.sources.map((s) => (
                      <span key={s} className="source-tag">{s}</span>
                    ))}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--color-text-muted)' }}>
                    {u.gsc_clicks ?? '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {u.status === 'unhandled' && (
                      <>
                        <button className="btn btn--sm" disabled={busy === u.id} onClick={() => addRedirect(u)}>
                          Add redirect
                        </button>{' '}
                        <button className="btn btn--ghost btn--sm" disabled={busy === u.id} onClick={() => toggleExcluded(u)}>
                          Mark excluded
                        </button>
                      </>
                    )}
                    {u.status === 'excluded' && (
                      <button className="btn btn--ghost btn--sm" disabled={busy === u.id} onClick={() => toggleExcluded(u)}>
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <style>{styles}</style>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  muted,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'info' | 'danger' | 'muted';
  muted?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`summary ${active ? 'is-active' : ''}`}
      onClick={onClick}
      data-tone={tone ?? (muted ? 'muted' : 'plain')}
    >
      <div className="summary__label">{label}</div>
      <div className="summary__value">{value}</div>
    </Tag>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`chip ${active ? 'is-active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: UrlStatus }) {
  return <span className={`status status--${status}`}>{status}</span>;
}

const styles = `
.cards-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
}
.summary {
  appearance: none;
  display: block;
  text-align: left;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  padding: 0.75rem 1rem;
  border-radius: var(--radius-md);
  cursor: pointer;
}
.summary:not(button) { cursor: default; }
.summary.is-active {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(15,23,42,0.06);
}
.summary__label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.summary__value { font-size: 1.75rem; font-weight: 600; margin-top: 4px; }
.summary[data-tone="success"] .summary__value { color: var(--color-success); }
.summary[data-tone="info"]    .summary__value { color: #3b82f6; }
.summary[data-tone="danger"]  .summary__value { color: var(--color-danger); }
.summary[data-tone="muted"]   .summary__value { color: var(--color-text-muted); }

.chip {
  appearance: none;
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: 999px;
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--color-text);
}
.chip.is-active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.urls-table { width: 100%; border-collapse: collapse; }
.urls-table thead tr { background: var(--color-bg); text-align: left; }
.urls-table th { padding: 0.75rem 1rem; font-size: 0.875rem; font-weight: 600; }
.urls-table td { padding: 0.6rem 1rem; border-top: 1px solid var(--color-border); vertical-align: middle; }
.urls-table__path, .urls-table__target {
  font-family: var(--font-mono); font-size: 0.85rem; max-width: 360px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.urls-table__sources { display: flex; flex-wrap: wrap; gap: 4px; }
.source-tag {
  font-size: 0.7rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--color-bg);
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}

.status {
  display: inline-block;
  padding: 0.125rem 0.625rem;
  border-radius: 999px;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.status--migrated   { background: rgba(22,163,74,0.12);  color: var(--color-success); }
.status--redirected { background: rgba(59,130,246,0.12); color: #3b82f6; }
.status--excluded   { background: rgba(120,113,108,0.12); color: var(--color-text-muted); }
.status--unhandled  { background: rgba(220,38,38,0.12);  color: var(--color-danger); }
`;
