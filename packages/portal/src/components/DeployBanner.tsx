/**
 * Dashboard-level summary of what's not yet on the live site.
 *
 * Three states:
 *  - Never deployed     → amber banner, "Deploy now"
 *  - Pending changes    → amber banner with counts + "Deploy"
 *  - Up to date         → quiet line with the last deploy time + "Redeploy"
 */
import { DeployButton } from './EditorStatus';

interface Props {
  siteId: string;
  pendingPages: number;
  pendingPartials: number;
  totalPending: number;
  lastDeployedAt: string | null;
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
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

export default function DeployBanner({
  siteId,
  pendingPages,
  pendingPartials,
  totalPending,
  lastDeployedAt,
}: Props) {
  const neverDeployed = !lastDeployedAt;
  const pending = totalPending > 0;
  const accent = neverDeployed || pending;

  const headline = neverDeployed
    ? 'This site has never been deployed.'
    : pending
      ? buildPendingLabel(pendingPages, pendingPartials)
      : `Live site is up to date · last deployed ${relTime(lastDeployedAt)}.`;

  return (
    <div className={`deploy-banner ${accent ? 'deploy-banner--accent' : 'deploy-banner--quiet'}`}>
      <div className="deploy-banner__pip" aria-hidden />
      <div className="deploy-banner__text">{headline}</div>
      <div className="deploy-banner__actions">
        <DeployButton siteId={siteId} pendingDeploy={accent} />
      </div>
      <style>{`
        .deploy-banner {
          display: flex; align-items: center; gap: 0.75rem;
          padding: 0.75rem 1rem;
          border-radius: var(--radius-md);
          border: 1px solid var(--color-border);
          background: var(--color-surface);
          margin-bottom: 1.5rem;
        }
        .deploy-banner--accent {
          background: color-mix(in srgb, #f6c177 12%, var(--color-surface));
          border-color: color-mix(in srgb, #f6c177 35%, var(--color-border));
        }
        .deploy-banner__pip {
          width: 10px; height: 10px; border-radius: 999px; flex-shrink: 0;
          background: var(--color-success);
        }
        .deploy-banner--accent .deploy-banner__pip { background: #f6c177; }
        .deploy-banner__text { flex: 1; font-size: 0.95rem; color: var(--color-text); }
        .deploy-banner__actions { display: inline-flex; align-items: center; gap: 0.5rem; }
      `}</style>
    </div>
  );
}

function buildPendingLabel(pages: number, partials: number): string {
  const parts: string[] = [];
  if (pages > 0) parts.push(`${pages} ${pages === 1 ? 'page' : 'pages'}`);
  if (partials > 0) parts.push(`${partials} ${partials === 1 ? 'block' : 'blocks'}`);
  return `${parts.join(' and ')} edited since the last deploy — visitors don't see the changes yet.`;
}
