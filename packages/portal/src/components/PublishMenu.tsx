/**
 * The Publish ▾ control — one button in the editor header that owns the
 * whole "how does my work get live?" story:
 *
 *   ┌──────────────────────────────┐
 *   │ Changes    ● Unsaved changes │  Save (deliberate) / Discard
 *   │ Status     [Published    ▾]  │  draft/review/unlisted/published
 *   │ Deploy     what changed list │  Redeploy full site → live
 *   └──────────────────────────────┘
 *
 * Editors autosave to a server-side working copy; nothing here is implicit.
 * Save promotes the working copy through the canonical PUT, status changes
 * apply immediately, and Redeploy rebuilds the whole static site from saved
 * + published content (the panel lists exactly what changed since the last
 * deploy so the redeploy button is never a mystery).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { isPendingDeploy } from './EditorStatus';

export interface StatusOption {
  value: string;
  label: string;
  description?: string;
}

/** Pages support the full status ladder. */
export const PAGE_STATUS_OPTIONS: StatusOption[] = [
  { value: 'draft', label: 'Draft', description: 'Excluded from deploys. Use Preview to view the saved draft.' },
  { value: 'review', label: 'In review', description: 'Awaiting review. Excluded from deploys.' },
  { value: 'unlisted', label: 'Unlisted', description: 'Included in deploys, but hidden from menus and the sitemap.' },
  { value: 'published', label: 'Published', description: 'Included in the next deploy. Changing this status does not deploy the site.' },
];

/** Partials and collection items are just draft/published. */
export const SIMPLE_STATUS_OPTIONS: StatusOption[] = [
  { value: 'draft', label: 'Draft', description: 'Excluded from deploys. Use Preview to view the saved draft.' },
  { value: 'published', label: 'Published', description: 'Included in the next deploy. Changing this status does not deploy the site.' },
];

interface ChangesResponse {
  last_deployed_at: string | null;
  never_deployed: boolean;
  total: number;
  changes: Array<{
    kind: string;
    id: string;
    title: string;
    date_updated: string;
    status?: string;
    will_deploy: boolean;
    collection?: string;
  }>;
}

type DeployPhase = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  phase?: string;
  error?: string;
};

interface PublishMenuProps {
  siteId: string;
  /** The doc's publish status (draft/review/unlisted/published). */
  pubStatus: string;
  /** Which statuses this doc kind supports. */
  statusOptions: StatusOption[];
  /** A working copy with unsaved edits exists. */
  hasUnsaved: boolean;
  /** An autosave/save is in flight. */
  saving?: boolean;
  onSave: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
  onStatusChange: (status: string) => Promise<void> | void;
  docUpdatedAt?: string | null;
  lastDeployedAt?: string | null;
  /** Opens the SAVED version in a new tab (drafts visible, unsaved edits
   *  excluded). Omit for docs without their own URL (partials). */
  previewUrl?: string | null;
  /** The page's permalink on the deployed live site. */
  liveUrl?: string | null;
  /** Scheduled publishing (optional — omit for docs without schedules).
   *  The sweep flips status and deploys when the time comes. */
  scheduledPublishAt?: string | null;
  scheduledUnpublishAt?: string | null;
  onSchedule?: (field: 'publish_at' | 'unpublish_at', iso: string | null) => Promise<void> | void;
  /** Opens the saved-vs-draft review overlay (docs that support it). */
  onReviewChanges?: () => void;
}

/** ISO ↔ datetime-local (browser inputs speak local time without a zone). */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function rel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

const KIND_LABEL: Record<string, string> = {
  page: 'Page',
  partial: 'Partial',
  template: 'Template',
  collection_item: 'Item',
};

export default function PublishMenu({
  siteId,
  pubStatus,
  statusOptions,
  hasUnsaved,
  saving = false,
  onSave,
  onDiscard,
  onStatusChange,
  docUpdatedAt,
  lastDeployedAt,
  previewUrl,
  liveUrl,
  scheduledPublishAt,
  scheduledUnpublishAt,
  onSchedule,
  onReviewChanges,
}: PublishMenuProps) {
  const statusHintId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);

  const [env, setEnv] = useState<'production' | 'staging'>('production');
  const [job, setJob] = useState<DeployPhase | null>(null);
  const [deployErr, setDeployErr] = useState<string | null>(null);
  const busy = job?.status === 'queued' || job?.status === 'running';

  const pending = isPendingDeploy(pubStatus, docUpdatedAt, lastDeployedAt);
  const attention = hasUnsaved || pending;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setChangesLoading(true);
    fetch(`/api/sites/${siteId}/changes-since-deploy`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setChanges(d))
      .catch(() => setChanges(null))
      .finally(() => setChangesLoading(false));
  }, [open, siteId, docUpdatedAt, hasUnsaved]);

  async function deploy() {
    const message = env === 'production'
      ? 'Rebuild and deploy the full site to production? Visitors see the new version when it finishes.'
      : 'Rebuild and deploy to the staging URL? Visitors won\'t see this.';
    if (!confirm(message)) return;
    setDeployErr(null);
    setJob({ status: 'queued', phase: 'starting' });
    try {
      const res = await fetch(`/api/sites/${siteId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: env }),
      });
      const data = await res.json();
      if (!res.ok || !data.jobId) throw new Error(data.error ?? 'Failed to start deploy');
      pollJob(data.jobId as string);
    } catch (e) {
      setDeployErr(e instanceof Error ? e.message : 'Failed to start deploy');
      setJob(null);
    }
  }

  function pollJob(jobId: string) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/sites/${siteId}/deploys/${jobId}`);
        const data = (await res.json()) as DeployPhase;
        setJob(data);
        if (data.status === 'succeeded') {
          stopped = true;
          // Reload so every status indicator reflects the new last_deployed_at.
          window.setTimeout(() => window.location.reload(), 600);
          return;
        }
        if (data.status === 'failed') {
          stopped = true;
          setDeployErr(data.error ?? 'Deploy failed');
          return;
        }
      } catch {
        // Transient — keep polling.
      }
      window.setTimeout(tick, 5000);
    };
    void tick();
  }

  const deployLabel = (() => {
    if (!job) return (changes ? changes.never_deployed : !lastDeployedAt) ? 'Deploy site' : 'Redeploy full site';
    if (job.status === 'queued') return 'Queued…';
    if (job.status === 'running') return job.phase ? `${job.phase}…` : 'Building…';
    if (job.status === 'succeeded') return 'Deployed ✓';
    return 'Failed';
  })();

  async function handleDiscard() {
    if (!confirm('Discard your unsaved changes and go back to the last saved version?')) return;
    await onDiscard();
  }

  return (
    <div className="pmenu" ref={rootRef}>
      <button
        type="button"
        className={`pmenu__trigger${attention ? ' pmenu__trigger--attention' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span
          className="pmenu__dot"
          style={{ background: attention ? '#f6c177' : '#4ade80' }}
        />
        Publish
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="pmenu__panel" role="menu">
          <div className="pmenu__mobile-header">
            <strong>Publishing</strong>
            <button type="button" aria-label="Close publishing menu" onClick={() => setOpen(false)}>Close</button>
          </div>
          <div className="pmenu__body">
          {/* ── Changes / deliberate save ─────────────────────────── */}
          <div className="pmenu__section">
            <div className="pmenu__label">Changes</div>
            {hasUnsaved ? (
              <>
                <div className="pmenu__row">
                  <span className="pmenu__state">
                    <span className="pmenu__dot" style={{ background: '#f6c177' }} />
                    Unsaved changes <span className="pmenu__muted">(autosaved as a working copy)</span>
                  </span>
                </div>
                <div className="pmenu__actions">
                  <button type="button" className="pmenu__btn pmenu__btn--primary" disabled={saving} onClick={() => void onSave()}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  {onReviewChanges && (
                    <button type="button" className="pmenu__btn pmenu__btn--ghost" onClick={() => { setOpen(false); onReviewChanges(); }}>
                      Review changes
                    </button>
                  )}
                  <button type="button" className="pmenu__btn pmenu__btn--ghost" disabled={saving} onClick={() => void handleDiscard()}>
                    Discard
                  </button>
                </div>
              </>
            ) : (
              <div className="pmenu__row">
                <span className="pmenu__state">
                  <span className="pmenu__dot" style={{ background: '#4ade80' }} />
                  All changes saved
                </span>
              </div>
            )}
            {previewUrl && (
              <>
                <div className="pmenu__actions">
                  <a
                    className="pmenu__btn pmenu__btn--ghost pmenu__linkbtn"
                    href={previewUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview ↗
                  </a>
                </div>
                <p className="pmenu__hint">
                  Opens the saved version in a new tab — drafts visible, unsaved edits excluded.
                </p>
              </>
            )}
          </div>

          {/* ── Status ─────────────────────────────────────────────── */}
          <div className="pmenu__section">
            <div className="pmenu__label">Status</div>
            <select
              aria-label="Publishing status"
              aria-describedby={statusHintId}
              className="pmenu__select"
              value={pubStatus}
              disabled={saving}
              onChange={(e) => void onStatusChange(e.target.value)}
            >
              {statusOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p id={statusHintId} className="pmenu__hint">
              {statusOptions.find((option) => option.value === pubStatus)?.description ?? 'Only published and unlisted content is included in deploys.'}
            </p>

            {onSchedule && pubStatus !== 'published' && (
              <>
                <div className="pmenu__label" style={{ marginTop: 8 }}>Publish automatically</div>
                <div className="pmenu__row">
                  <input
                    type="datetime-local"
                    className="pmenu__select"
                    value={isoToLocalInput(scheduledPublishAt)}
                    disabled={saving}
                    onChange={(e) => void onSchedule('publish_at', localInputToIso(e.target.value))}
                  />
                  {scheduledPublishAt && (
                    <button type="button" className="pmenu__btn pmenu__btn--ghost" disabled={saving}
                      onClick={() => void onSchedule('publish_at', null)}>
                      Clear
                    </button>
                  )}
                </div>
                <p className="pmenu__hint">
                  {scheduledPublishAt
                    ? `Publishes and deploys ${new Date(scheduledPublishAt).toLocaleString()}. Schedules apply to SAVED content — save your draft first.`
                    : 'Pick a time to publish + deploy automatically.'}
                </p>
              </>
            )}
            {onSchedule && pubStatus === 'published' && (
              <>
                <div className="pmenu__label" style={{ marginTop: 8 }}>Unpublish automatically</div>
                <div className="pmenu__row">
                  <input
                    type="datetime-local"
                    className="pmenu__select"
                    value={isoToLocalInput(scheduledUnpublishAt)}
                    disabled={saving}
                    onChange={(e) => void onSchedule('unpublish_at', localInputToIso(e.target.value))}
                  />
                  {scheduledUnpublishAt && (
                    <button type="button" className="pmenu__btn pmenu__btn--ghost" disabled={saving}
                      onClick={() => void onSchedule('unpublish_at', null)}>
                      Clear
                    </button>
                  )}
                </div>
                {scheduledUnpublishAt && (
                  <p className="pmenu__hint">
                    Reverts to draft and redeploys {new Date(scheduledUnpublishAt).toLocaleString()}.
                  </p>
                )}
              </>
            )}
          </div>

          {/* ── Deploy ─────────────────────────────────────────────── */}
          <div className="pmenu__section">
            <div className="pmenu__label">Live site</div>
            <p className="pmenu__hint" style={{ marginTop: 0 }}>
              {changes?.never_deployed
                ? 'Never deployed.'
                : changes?.last_deployed_at
                  ? `Last deployed ${rel(changes.last_deployed_at)}.`
                  : lastDeployedAt
                    ? `Last deployed ${rel(lastDeployedAt)}.`
                    : ''}
            </p>

            {changesLoading && <p className="pmenu__hint">Checking what changed…</p>}
            {!changesLoading && changes && changes.total === 0 && !changes.never_deployed && (
              <p className="pmenu__hint">The live site is up to date with your saved content.</p>
            )}
            {hasUnsaved && (
              <p className="pmenu__hint pmenu__hint--warn">
                Your unsaved changes are NOT included in a deploy — Save first.
              </p>
            )}

            {previewUrl && (!liveUrl || pending) && (pubStatus === 'published' || pubStatus === 'unlisted') && (
              <p className="pmenu__hint">No live URL yet — deploy the saved page first. Preview is available above.</p>
            )}
            {liveUrl && !pending && (
              (pubStatus === 'published' || pubStatus === 'unlisted') ? (
                <div className="pmenu__actions" style={{ marginTop: '0.35rem' }}>
                  <a
                    className="pmenu__btn pmenu__btn--ghost pmenu__linkbtn"
                    href={liveUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="The currently deployed version of this page"
                  >
                    Live URL ↗
                  </a>
                </div>
              ) : (
                <p className="pmenu__hint">No live URL — the page isn't published.</p>
              )
            )}

          </div>
          </div>
          <div className="pmenu__section pmenu__deploy-footer">
            <div className="pmenu__actions">
              <select
                aria-label="Deployment environment"
                className="pmenu__select pmenu__select--env"
                value={env}
                disabled={busy}
                onChange={(e) => setEnv(e.target.value as 'production' | 'staging')}
                title="Production updates the live domain; staging only updates the staging URL."
              >
                <option value="production">Production</option>
                <option value="staging">Staging</option>
              </select>
              <button
                type="button"
                className="pmenu__btn pmenu__btn--primary"
                disabled={busy}
                onClick={() => void deploy()}
              >
                {deployLabel}
              </button>
            </div>
            {deployErr && <p className="pmenu__hint pmenu__hint--error">{deployErr}</p>}
            {!changesLoading && changes && changes.total > 0 && (
              <details className="pmenu__change-details">
                <summary>
                  {changes.never_deployed ? 'Content for first deploy' : 'Changes since last deploy'} ({changes.total})
                </summary>
                <div className="pmenu__change-list">
                  <p className="pmenu__hint">
                    {changes.never_deployed
                      ? 'Saved content before the first deploy.'
                      : 'Saved content changed since the last deploy.'}
                    {' '}Each item appears once, even after multiple edits. Deploy rebuilds the whole site.
                  </p>
                  <ul className="pmenu__changes">
                    {changes.changes.map((c) => (
                      <li key={`${c.kind}:${c.collection ?? ''}:${c.id}`}>
                        <span className="pmenu__kind">{KIND_LABEL[c.kind] ?? c.kind}</span>
                        <span className="pmenu__title">{c.title}</span>
                        <span className={c.will_deploy ? 'pmenu__included' : 'pmenu__skip'}>
                          {c.will_deploy ? 'Included in deploy' : `Not included: ${c.status ?? 'draft'}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {changes.total > changes.changes.length && (
                    <p className="pmenu__hint">Showing the latest {changes.changes.length} of {changes.total} changed items.</p>
                  )}
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      <style>{`
        .pmenu__mobile-header { display: none; }
        .pmenu { position: relative; display: inline-block; }
        .pmenu__trigger {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 0.35rem 0.7rem; font-size: 0.85rem; font-weight: 600;
          border-radius: 6px; cursor: pointer;
          background: #18181b; color: #fafafa; border: 1px solid #3f3f46;
        }
        .pmenu__trigger--attention { background: #4f46e5; border-color: #4f46e5; color: #fff; }
        .pmenu__dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
        .pmenu__panel {
          position: absolute; right: 0; top: calc(100% + 6px); z-index: 200;
          width: 320px; padding: 0.25rem 0;
          background: #1f1f23; color: #e4e4e7;
          border: 1px solid #34343a; border-radius: 10px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.4);
          text-align: left;
        }
        .pmenu__deploy-footer { border-top: 1px solid #34343a; }
        .pmenu__section { padding: 0.7rem 0.9rem; }
        .pmenu__section + .pmenu__section { border-top: 1px solid #2a2a30; }
        .pmenu__label {
          font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em;
          color: #a1a1aa; margin-bottom: 0.45rem; font-weight: 600;
        }
        .pmenu__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .pmenu__state { display: inline-flex; align-items: center; gap: 7px; font-size: 0.875rem; }
        .pmenu__muted { color: #a1a1aa; font-size: 0.875rem; }
        .pmenu__actions { display: flex; gap: 6px; margin-top: 0.55rem; align-items: center; }
        .pmenu__btn {
          padding: 0.32rem 0.7rem; font-size: 0.875rem; font-weight: 600;
          border-radius: 6px; cursor: pointer; border: 1px solid transparent;
        }
        .pmenu__btn:disabled { opacity: 0.55; cursor: default; }
        .pmenu__btn--primary { background: #4f46e5; color: #fff; }
        .pmenu__btn--ghost { background: none; color: #a1a1aa; border-color: #34343a; }
        .pmenu__linkbtn { text-decoration: none; display: inline-flex; align-items: center; }
        .pmenu__linkbtn:hover { color: #e4e4e7; border-color: #52525b; }
        .pmenu__select {
          width: 100%; padding: 0.5rem 0.625rem; font-size: 1rem;
          background: #26262b; color: #fafafa;
          border: 1px solid #34343a; border-radius: 6px;
        }
        select.pmenu__select {
          appearance: none; padding-right: 2rem;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23d4d4d8' stroke-width='1.5'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 0.65rem center;
        }
        .pmenu__select--env { width: auto; flex: 1; }
        .pmenu__hint { margin: 0.4rem 0 0; font-size: 0.875rem; color: #a1a1aa; line-height: 1.45; }
        .pmenu__hint--warn { color: #f6c177; }
        .pmenu__hint--error { color: #f87171; }
        .pmenu__change-details { margin-top: 8px; border-top: 1px solid #34343a; }
        .pmenu__change-details summary { padding: 10px 0; min-height: 44px; font-size: 0.875rem; line-height: 1.4; cursor: pointer; overflow-wrap: anywhere; }
        .pmenu__change-details summary:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
        .pmenu__change-list { max-height: min(16rem, 30dvh); overflow-y: auto; overscroll-behavior: contain; }
        .pmenu__changes { list-style: none; margin: 8px 0 0; padding: 0; }
        .pmenu__changes li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; font-size: 0.875rem; line-height: 1.4; padding: 8px 0; min-width: 0; border-top: 1px solid #34343a; }
        .pmenu__kind { align-self: start; font-size: 0.75rem; color: #a1a1aa; border: 1px solid #34343a; border-radius: 4px; padding: 1px 4px; }
        .pmenu__title { overflow-wrap: anywhere; }
        .pmenu__included, .pmenu__skip { grid-column: 2; font-size: 0.75rem; }
        .pmenu__included { color: #a1a1aa; }
        .pmenu__skip { color: #f6c177; }
        @media (max-width: 1000px) {
          .pmenu__trigger { min-height: 44px; white-space: nowrap; }
          .pmenu__panel { position: fixed; top: max(12px, env(safe-area-inset-top)); right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); width: min(360px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); display: flex; flex-direction: column; overflow: hidden; }
          .pmenu__body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
          .pmenu__deploy-footer { flex-shrink: 0; background: #1f1f23; border-radius: 0 0 10px 10px; }
          .pmenu__deploy-footer .pmenu__actions { flex-wrap: nowrap; margin-top: 0; }
          .pmenu__deploy-footer .pmenu__btn { flex: 1; }
          .pmenu__mobile-header { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; position: sticky; top: 0; padding: 4px 12px; background: #1f1f23; border-bottom: 1px solid #34343a; z-index: 1; }
          .pmenu__mobile-header button { min-height: 44px; padding: 6px 12px; color: #fafafa; background: #26262b; border: 1px solid #34343a; border-radius: 6px; cursor: pointer; }
          .pmenu__actions, .pmenu__row, .pmenu__state { flex-wrap: wrap; }
          .pmenu__btn, .pmenu__select { min-height: 44px; }
          .pmenu__select { font-size: 16px; min-width: 0; max-width: 100%; }
        }
      `}</style>
    </div>
  );
}
