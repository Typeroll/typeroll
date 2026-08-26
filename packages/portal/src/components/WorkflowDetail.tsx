import { useEffect, useState } from 'react';
import type { WorkflowRecord } from '../lib/workflows/types';

interface Props {
  siteId: string;
  workflowId: string;
  initial: WorkflowRecord;
  stepNames: Array<{ name: string; label: string }>;
}

const ACTIVE_STATUSES = new Set<WorkflowRecord['status']>(['pending', 'running']);

export default function WorkflowDetail({ siteId, workflowId, initial, stepNames }: Props) {
  const [wf, setWf] = useState<WorkflowRecord>(initial);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    async function tick() {
      if (stopped) return;
      try {
        const res = await fetch(`/api/sites/${siteId}/workflows/${workflowId}`);
        if (res.ok) {
          const data = (await res.json()) as WorkflowRecord;
          setWf(data);
          if (ACTIVE_STATUSES.has(data.status)) {
            timer = window.setTimeout(tick, 1500);
          }
        }
      } catch {
        timer = window.setTimeout(tick, 4000);
      }
    }

    if (ACTIVE_STATUSES.has(wf.status)) {
      timer = window.setTimeout(tick, 1500);
    }
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [siteId, workflowId, wf.status]);

  async function approve() {
    setApproving(true);
    try {
      await fetch(`/api/sites/${siteId}/workflows/${workflowId}/approve`, { method: 'POST' });
      // Polling will pick up the running status.
      const res = await fetch(`/api/sites/${siteId}/workflows/${workflowId}`);
      if (res.ok) setWf(await res.json());
    } finally {
      setApproving(false);
    }
  }

  const progress = wf.progress
    ? Math.round((wf.progress.completed / Math.max(wf.progress.total, 1)) * 100)
    : 0;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <span className={`badge badge--${wf.status}`}>{wf.status}</span>
            {wf.current_step && (
              <span style={{ marginLeft: 12 }} className="muted text-sm">Current step: {wf.current_step}</span>
            )}
          </div>
          <div className="muted text-sm">
            {wf.progress && `${wf.progress.completed}/${wf.progress.total} steps`}
          </div>
        </div>

        <div style={{ background: 'var(--color-bg)', borderRadius: 8, overflow: 'hidden', height: 8 }}>
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              background: wf.status === 'failed' ? 'var(--color-danger)' : wf.status === 'completed' ? 'var(--color-success)' : 'var(--color-primary)',
              transition: 'width 0.3s',
            }}
          />
        </div>

        <div className="stack-sm">
          {stepNames.map((s, i) => {
            const completed = wf.progress ? i < wf.progress.completed : false;
            const current = wf.current_step === s.name && ACTIVE_STATUSES.has(wf.status);
            return (
              <div key={s.name} className="row text-sm" style={{ gap: 8 }}>
                <span style={{ width: 18 }}>
                  {completed ? '✓' : current ? '●' : '○'}
                </span>
                <span style={{ color: completed ? 'var(--color-text-muted)' : 'var(--color-text)', fontWeight: current ? 600 : 400 }}>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {wf.status === 'paused_for_review' && (
        <div className="card stack" style={{ borderColor: '#3b82f6' }}>
          <h3 style={{ fontSize: '1rem' }}>Review required</h3>
          <p>{wf.review_message ?? 'This workflow is paused for review.'}</p>
          {wf.review_data && (
            <pre style={{ fontSize: '0.8rem', background: 'var(--color-bg)', padding: '0.75rem', borderRadius: 6, overflow: 'auto' }}>
              {JSON.stringify(wf.review_data, null, 2)}
            </pre>
          )}
          <div className="row">
            <button className="btn" onClick={approve} disabled={approving}>
              {approving ? 'Approving…' : 'Approve & continue'}
            </button>
          </div>
        </div>
      )}

      {wf.status === 'failed' && (
        <div className="card" style={{ borderColor: 'var(--color-danger)' }}>
          <h3 style={{ fontSize: '1rem', color: 'var(--color-danger)' }}>Failed</h3>
          <p className="text-sm">{wf.failure_reason ?? 'Unknown error'}</p>
        </div>
      )}

      {wf.results && Object.keys(wf.results).length > 0 && (
        <div className="card stack">
          <h3 style={{ fontSize: '1rem' }}>Results</h3>
          <pre style={{ fontSize: '0.8rem', background: 'var(--color-bg)', padding: '0.75rem', borderRadius: 6, overflow: 'auto' }}>
            {JSON.stringify(wf.results, null, 2)}
          </pre>
        </div>
      )}

      {wf.log && wf.log.length > 0 && (
        <div className="card stack">
          <h3 style={{ fontSize: '1rem' }}>Log</h3>
          <pre style={{ fontSize: '0.75rem', background: 'var(--color-bg)', padding: '0.75rem', borderRadius: 6, overflow: 'auto', maxHeight: 400, fontFamily: 'var(--font-mono)' }}>
            {wf.log.join('\n')}
          </pre>
        </div>
      )}

      <style>{`
        .badge {
          display: inline-block;
          padding: 0.125rem 0.625rem;
          border-radius: 999px;
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          font-weight: 500;
        }
        .badge--completed { background: rgba(22,163,74,0.12); color: var(--color-success); }
        .badge--running { background: rgba(245,158,11,0.12); color: var(--color-accent); }
        .badge--paused_for_review { background: rgba(59,130,246,0.12); color: #3b82f6; }
        .badge--failed { background: rgba(220,38,38,0.12); color: var(--color-danger); }
        .badge--pending { background: rgba(120,113,108,0.12); color: var(--color-text-muted); }
      `}</style>
    </div>
  );
}
