/**
 * Recent deploy jobs for the site. Lazy-fetched on mount so the dashboard
 * server-render stays fast — most users glance at the deploy banner and
 * never look down here.
 */
import { useEffect, useState } from 'react';
import type { DeployJob } from '@typeroll/shared';

interface Props {
  siteId: string;
}

function relTime(iso: string | undefined): string {
  if (!iso) return '—';
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

function duration(job: DeployJob): string {
  if (!job.finished_at) return '—';
  const ms = Date.parse(job.finished_at) - Date.parse(job.started_at);
  if (Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const STATUS_COLOR: Record<string, string> = {
  succeeded: 'var(--color-success)',
  failed: 'var(--color-danger)',
  running: '#f6c177',
  queued: 'var(--color-text-muted)',
};

export default function DeployHistory({ siteId }: Props) {
  const [jobs, setJobs] = useState<DeployJob[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/sites/${siteId}/deploy`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error ?? 'Failed to load history');
        setJobs(data.jobs ?? []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load history');
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [siteId]);

  if (err) {
    return <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{err}</p>;
  }
  if (jobs === null) {
    return <p className="muted text-sm">Loading deploy history…</p>;
  }
  if (jobs.length === 0) {
    return <p className="muted text-sm">No deploys yet for this site.</p>;
  }

  return (
    <ul className="dh">
      {jobs.map((j) => (
        <li key={j.id} className="dh__row">
          <span className="dh__pip" style={{ background: STATUS_COLOR[j.status] ?? '#aaa' }} aria-hidden />
          <div className="dh__main">
            <div className="dh__top">
              <span className="dh__status">{j.status}</span>
              <span className="muted text-sm">· {j.environment}</span>
              {j.status === 'running' && j.phase && (
                <span className="muted text-sm">· {j.phase}</span>
              )}
            </div>
            <div className="muted text-sm">
              {relTime(j.started_at)}
              {j.finished_at && ` · ${duration(j)}`}
              {j.triggered_by && ` · ${j.triggered_by}`}
            </div>
            {j.error && (
              <div className="text-sm" style={{ color: 'var(--color-danger)', marginTop: 2 }}>
                {j.error}
              </div>
            )}
            {j.warnings?.map((warning) => (
              <div key={warning} className="text-sm" style={{ color: '#b7791f', marginTop: 2 }}>
                Warning: {warning}
              </div>
            ))}
          </div>
          {j.deploy_url && (
            <a href={j.deploy_url} target="_blank" rel="noopener noreferrer" className="text-sm">
              Open ↗
            </a>
          )}
        </li>
      ))}
      <style>{`
        .dh { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
        .dh__row {
          display: flex; align-items: flex-start; gap: 0.75rem;
          padding: 0.55rem 0.7rem;
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          background: var(--color-surface);
        }
        .dh__pip {
          width: 8px; height: 8px; border-radius: 999px; flex-shrink: 0;
          margin-top: 0.45rem;
        }
        .dh__main { flex: 1; min-width: 0; }
        .dh__top { display: inline-flex; align-items: baseline; gap: 0.4rem; }
        .dh__status { font-weight: 600; text-transform: capitalize; font-size: 0.92rem; }
      `}</style>
    </ul>
  );
}
