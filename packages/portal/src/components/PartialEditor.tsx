import { useEffect, useMemo, useRef, useState } from 'react';
import type { Partial as PartialDoc, WorkingCopy } from '@typeroll/shared';
import HistoryPanel from './HistoryPanel';
import { DocStatus } from './EditorStatus';
import PublishMenu, { SIMPLE_STATUS_OPTIONS } from './PublishMenu';
import BlockUsage from './BlockUsage';

interface Props {
  siteId: string;
  partial: PartialDoc;
  /** Unsaved autosaved edits, loaded server-side. Overlaid at mount. */
  workingCopy?: WorkingCopy | null;
  lastDeployedAt: string | null;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';

export default function PartialEditor({ siteId, partial, workingCopy, lastDeployedAt }: Props) {
  const [draft, setDraft] = useState<PartialDoc>(
    { ...partial, ...(workingCopy?.fields ?? {}) } as PartialDoc,
  );
  const [hasWc, setHasWc] = useState<boolean>(!!workingCopy);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview' | 'history'>('edit');

  const initial = useRef(true);
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef<string>(JSON.stringify({ ...partial, ...(workingCopy?.fields ?? {}) }));

  const dirty = useMemo(() => JSON.stringify(draft) !== lastSaved.current, [draft, status]);

  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    if (!dirty) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [draft]);

  /** Fields that autosave to the working copy — status is a deliberate
   *  action in the Publish menu, timestamps are server-stamped. */
  function contentFields(d: PartialDoc): Record<string, unknown> {
    const { id: _id, status: _st, date_updated: _du, ...rest } = d as PartialDoc & Record<string, unknown>;
    return rest;
  }

  // Autosave — writes the working copy, never the canonical partial.
  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/working-copy/partial/${draft.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: contentFields(draft) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Autosave failed');
      lastSaved.current = JSON.stringify(draft);
      setHasWc(true);
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Autosave failed');
      setStatus('error');
    }
  }

  // Deliberate Save — flush the latest draft into the working copy, then
  // COMMIT it server-side (shared path with the v1 API agents use).
  async function saveAll() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setStatus('saving');
    setError(null);
    try {
      const wcUrl = `/api/sites/${siteId}/working-copy/partial/${draft.id}`;
      const flush = await fetch(wcUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: contentFields(draft) }),
      });
      if (!flush.ok) {
        const j = await flush.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? 'Save failed');
      }
      const res = await fetch(wcUrl, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setHasWc(false);
      // Stamp + move the dirty baseline atomically so the stamp doesn't
      // re-dirty the draft and recreate the working copy via autosave.
      setDraft((d) => {
        const updated = { ...d, date_updated: new Date().toISOString() };
        lastSaved.current = JSON.stringify(updated);
        return updated;
      });
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  }

  async function discardWc() {
    await fetch(`/api/sites/${siteId}/working-copy/partial/${draft.id}`, { method: 'DELETE' });
    window.location.reload();
  }

  async function changeStatus(next: string) {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/partials/${draft.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Status change failed');
      setDraft((d) => {
        const updated = { ...d, status: next as PartialDoc['status'], date_updated: new Date().toISOString() };
        lastSaved.current = JSON.stringify(updated);
        return updated;
      });
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status change failed');
      setStatus('error');
    }
  }

  function update<K extends keyof PartialDoc>(key: K, value: PartialDoc[K]) {
    setDraft({ ...draft, [key]: value });
  }

  return (
    <div className="stack" style={{ maxWidth: 1100 }}>
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: 12 }}>
            <DocStatus
              save={status}
              dirty={dirty || hasWc}
              error={error}
              pubStatus={draft.status}
              docUpdatedAt={draft.date_updated}
              lastDeployedAt={lastDeployedAt}
            />
          </div>
          <div className="row">
            <PublishMenu
              siteId={siteId}
              pubStatus={draft.status}
              statusOptions={SIMPLE_STATUS_OPTIONS}
              hasUnsaved={dirty || hasWc}
              saving={status === 'saving'}
              onSave={saveAll}
              onDiscard={discardWc}
              onStatusChange={changeStatus}
              docUpdatedAt={draft.date_updated ?? null}
              lastDeployedAt={lastDeployedAt}
            />
          </div>
        </div>

        <div className="field">
          <label>Name</label>
          <input value={draft.name} onChange={(e) => update('name', e.target.value)} />
        </div>

        <BlockUsage siteId={siteId} partialId={draft.id} kind={draft.kind ?? 'free'} />

        <div className="tabs">
          <button onClick={() => setTab('edit')} className={tab === 'edit' ? 'is-active' : ''}>HTML</button>
          <button onClick={() => setTab('preview')} className={tab === 'preview' ? 'is-active' : ''}>Preview</button>
          <button onClick={() => setTab('history')} className={tab === 'history' ? 'is-active' : ''}>History</button>
        </div>

        {tab === 'history' ? (
          <HistoryPanel endpoint={`/api/sites/${siteId}/partials/${draft.id}/revisions`} />
        ) : tab === 'edit' ? (
          <div>
            <textarea
              value={draft.html_content ?? ''}
              onChange={(e) => update('html_content', e.target.value)}
              rows={18}
              style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', padding: '0.75rem', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-bg)' }}
              spellCheck={false}
              placeholder={'<nav>\n  <a href="/">Home</a>\n  <a href="/about">About</a>\n</nav>'}
            />
            <p className="muted text-sm" style={{ marginTop: 4 }}>
              {draft.kind === 'header' && 'The site\'s main navigation lives here. Inline styles or CSS variables (var(--color-primary), var(--spacing-md)) both work.'}
              {draft.kind === 'footer' && 'Site-wide footer content. Inline styles or CSS variables work.'}
              {draft.kind === 'free' && (
                <>
                  Insert this block into any page with{' '}
                  <code style={{ background: 'var(--color-bg)', padding: '1px 5px', borderRadius: 4 }}>
                    {`<x-include name="${draft.id}" />`}
                  </code>
                  . Inline styles or CSS variables both work.
                </>
              )}
            </p>
          </div>
        ) : (
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '1rem', background: 'white' }} dangerouslySetInnerHTML={{ __html: draft.html_content ?? '' }} />
        )}
      </div>

      <style>{`
        .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border); }
        .tabs button {
          padding: 0.5rem 0.75rem; background: none; border: 0; cursor: pointer;
          color: var(--color-text-muted); font-weight: 500;
          border-bottom: 2px solid transparent; margin-bottom: -1px;
        }
        .tabs button.is-active { color: var(--color-text); border-bottom-color: var(--color-primary); }
      `}</style>
    </div>
  );
}
