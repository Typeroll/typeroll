/**
 * Shared status indicator + deploy button used across the three editors
 * (HtmlPageEditor, PartialEditor, CollectionItemEditor). The goal is a
 * single, consistent answer to the question "is what I see live yet?":
 *
 *   ● Saving…
 *   ● Unsaved changes…
 *   ● Saved · published · pending deploy
 *   ● Saved · published · up to date with live
 *   ● Saved · draft · won't be in next deploy
 *
 * Plus a one-click Deploy button that hits /api/sites/{id}/deploy and
 * refreshes the editor so the indicator flips to "up to date".
 */

import { useState } from 'react';
import { useDeployProgress } from './useDeployProgress';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type PublishStatus = 'draft' | 'review' | 'unlisted' | 'published' | string;

interface IndicatorProps {
  save: SaveStatus;
  dirty: boolean;
  error: string | null;
  /** The doc's publish-status field (draft/published/...). */
  pubStatus: PublishStatus;
  /** ISO date the underlying doc was last written. */
  docUpdatedAt?: string | null;
  /** ISO date this version was last deployed. */
  lastDeployedAt?: string | null;
}

export function DocStatus({
  save,
  dirty,
  error,
  pubStatus,
  docUpdatedAt,
  lastDeployedAt,
}: IndicatorProps) {
  if (save === 'saving') return <span className="muted text-sm">Saving…</span>;
  if (save === 'error') return <span className="text-sm" style={{ color: 'var(--color-danger)' }}>{error ?? 'Error'}</span>;
  if (dirty) {
    return (
      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        <span style={{ color: '#f6c177' }}>● </span>Unsaved changes — save via Publish
      </span>
    );
  }

  // Compute deploy state. A doc is "pending deploy" if it's been written
  // since the last deploy of its version (or if no deploy has happened).
  const shipsOnDeploy = pubStatus === 'published' || pubStatus === 'unlisted';
  const pendingDeploy = shipsOnDeploy && (
    !lastDeployedAt || (docUpdatedAt && docUpdatedAt > lastDeployedAt)
  );

  let hint: string;
  let dotColor: string;
  if (!shipsOnDeploy) {
    hint = `Saved · ${pubStatus} — not on the live site yet`;
    dotColor = 'var(--color-text-muted)';
  } else if (pendingDeploy) {
    hint = lastDeployedAt
      ? `Saved · pending deploy`
      : `Saved · ${pubStatus}, never deployed`;
    dotColor = '#f6c177'; // amber — needs attention
  } else {
    hint = `Saved · up to date with live`;
    dotColor = 'var(--color-success)';
  }

  return (
    <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
      <span style={{ color: dotColor }}>● </span>{hint}
    </span>
  );
}

interface DeployButtonProps {
  siteId: string;
  /** Hide the button until the doc actually needs a deploy. */
  pendingDeploy?: boolean;
  /** Called after a successful deploy. Useful to refresh editor state. */
  onDeployed?: () => void;
}


export function DeployButton({ siteId, pendingDeploy = true, onDeployed }: DeployButtonProps) {
  const [env, setEnv] = useState<'production' | 'staging'>('production');
  const [err, setErr] = useState<string | null>(null);
  const { job, setJob, watch } = useDeployProgress(siteId, setErr, onDeployed);

  const busy = job?.status === 'queued' || job?.status === 'running';

  async function go() {
    const message = env === 'production'
      ? 'Deploy to your live production site? This rebuilds the static files and uploads them. Visitors will see the new version once it finishes.'
      : 'Deploy to the staging URL? Visitors won\'t see this.';
    if (!confirm(message)) return;
    setErr(null);
    setJob({ status: 'queued', phase: 'starting' });
    try {
      const res = await fetch(`/api/sites/${siteId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: env }),
      });
      const data = await res.json();
      if (!res.ok || !(data.jobId ?? data.job_id)) throw new Error(data.error ?? 'Failed to start deploy');
      watch((data.jobId ?? data.job_id) as string);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to start deploy');
      setJob(null);
    }
  }

  const label = (() => {
    if (!job) return pendingDeploy ? 'Deploy →' : 'Redeploy';
    if (job.status === 'queued') return 'Queued…';
    if (job.phase === 'distributing') return 'Distributing…';
    if (job.status === 'running') return job.phase ? `${job.phase}…` : 'Running…';
    if (job.status === 'succeeded') return 'Deployed ✓';
    return 'Failed';
  })();

  return (
    <>
      <select
        value={env}
        onChange={(e) => setEnv(e.target.value as 'production' | 'staging')}
        disabled={busy}
        title="Production updates the live domain; staging only updates the staging URL."
        className="deploy-env"
      >
        <option value="production">Production</option>
        <option value="staging">Staging</option>
      </select>
      <button
        type="button"
        className={pendingDeploy && !job ? 'btn btn--sm' : 'btn btn--secondary btn--sm'}
        onClick={go}
        disabled={busy}
        title={pendingDeploy ? 'There are saved changes not yet on the live site' : 'Rebuild and redeploy the live site'}
      >
        {label}
      </button>
      {busy && job?.verification_message && <span role="status" className="text-sm">{job.verification_message}</span>}
      {job?.phase === 'distributing' && <span role="status" className="text-sm">Distributing… The link will appear automatically when ready.</span>}
      {err && (
        <span className="text-sm" style={{ color: 'var(--color-danger)', marginLeft: 8 }}>
          {err}
        </span>
      )}
      <style>{`
        .deploy-env {
          padding: 0.25rem 0.4rem;
          font-size: 0.85rem;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          background: var(--color-surface);
          color: var(--color-text);
        }
        .deploy-env:disabled { opacity: 0.55; }
      `}</style>
    </>
  );
}

/** Pure helper so a parent can pre-compute pendingDeploy without re-rendering. */
export function isPendingDeploy(
  pubStatus: PublishStatus,
  docUpdatedAt?: string | null,
  lastDeployedAt?: string | null,
): boolean {
  if (pubStatus !== 'published' && pubStatus !== 'unlisted') return false;
  if (!lastDeployedAt) return true;
  if (!docUpdatedAt) return false;
  return docUpdatedAt > lastDeployedAt;
}
