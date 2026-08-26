import { useEffect, useMemo, useRef, useState } from 'react';
import HistoryPanel from './HistoryPanel';
import type { CollectionDef, CollectionItem, FieldDefinition, WorkingCopy } from '@typeroll/shared';
import MediaPicker from './MediaPicker';
import { DocStatus } from './EditorStatus';
import PublishMenu, { SIMPLE_STATUS_OPTIONS } from './PublishMenu';

interface Props {
  siteId: string;
  collection: CollectionDef;
  item: CollectionItem;
  /** Unsaved autosaved edits, loaded server-side. Overlaid at mount. */
  workingCopy?: WorkingCopy | null;
  /** Preview address for the item's route (saved content). */
  previewUrl?: string | null;
  /** Permalink on the deployed site. */
  liveUrl?: string | null;
  lastDeployedAt: string | null;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function CollectionItemEditor({ siteId, collection, item, workingCopy, previewUrl, liveUrl, lastDeployedAt }: Props) {
  const [data, setData] = useState<Record<string, unknown>>(() => ({
    ...item,
    status: item.status ?? 'draft',
    ...(workingCopy?.fields ?? {}),
  }));
  const [hasWc, setHasWc] = useState<boolean>(!!workingCopy);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const initial = useRef(true);
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef<string>(JSON.stringify({
    ...item,
    status: item.status ?? 'draft',
    ...(workingCopy?.fields ?? {}),
  }));

  const dirty = useMemo(() => JSON.stringify(data) !== lastSaved.current, [data, status]);

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
  }, [data]);

  /** Schema fields only — status is a deliberate action in the Publish
   *  menu, id/timestamps never autosave. */
  function contentFields(d: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of collection.fields) {
      if (f.name in d) out[f.name] = d[f.name];
    }
    return out;
  }

  const wcUrl = `/api/sites/${siteId}/working-copy/item/${collection.name}/${item.id}`;

  // Autosave — writes the working copy, never the canonical item.
  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(wcUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: contentFields(data) }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'Autosave failed');
      lastSaved.current = JSON.stringify(data);
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
      const flush = await fetch(wcUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: contentFields(data) }),
      });
      if (!flush.ok) {
        const j = await flush.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? 'Save failed');
      }
      const res = await fetch(wcUrl, { method: 'POST' });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'Save failed');
      setHasWc(false);
      // Stamp + move the dirty baseline atomically so the stamp doesn't
      // re-dirty the data and recreate the working copy via autosave.
      setData((d) => {
        const updated = { ...d, updated_at: new Date().toISOString() };
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
    await fetch(wcUrl, { method: 'DELETE' });
    window.location.reload();
  }

  async function changeStatus(next: string) {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(
        `/api/sites/${siteId}/collections/${collection.name}/items/${item.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        }
      );
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'Status change failed');
      setData((d) => {
        const updated = { ...d, status: next, updated_at: new Date().toISOString() };
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

  async function destroy() {
    if (!confirm('Delete this item?')) return;
    const res = await fetch(
      `/api/sites/${siteId}/collections/${collection.name}/items/${item.id}`,
      { method: 'DELETE' }
    );
    if (res.ok) window.location.href = `/app/sites/${siteId}/collections/${collection.name}`;
  }

  function update(name: string, value: unknown) {
    setData({ ...data, [name]: value });
  }

  return (
    <div className="stack" style={{ maxWidth: 800 }}>
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <DocStatus
            save={status}
            dirty={dirty || hasWc}
            error={error}
            pubStatus={String(data.status ?? 'draft')}
            docUpdatedAt={typeof data.updated_at === 'string' ? data.updated_at : null}
            lastDeployedAt={lastDeployedAt}
          />
          <div className="row">
            <PublishMenu
              siteId={siteId}
              pubStatus={String(data.status ?? 'draft')}
              statusOptions={SIMPLE_STATUS_OPTIONS}
              hasUnsaved={dirty || hasWc}
              saving={status === 'saving'}
              onSave={saveAll}
              onDiscard={discardWc}
              onStatusChange={changeStatus}
              docUpdatedAt={typeof data.updated_at === 'string' ? data.updated_at : null}
              lastDeployedAt={lastDeployedAt}
              previewUrl={previewUrl}
              liveUrl={liveUrl}
            />
            <button onClick={destroy} className="btn btn--ghost btn--sm">Delete</button>
          </div>
        </div>

        {collection.fields.map((f) => (
          <FieldInput
            key={f.name}
            field={f}
            value={data[f.name]}
            onChange={(v) => update(f.name, v)}
            siteId={siteId}
          />
        ))}
      </div>

      <div className="card stack">
        <h2 style={{ fontSize: '1rem' }}>History</h2>
        <HistoryPanel endpoint={`/api/sites/${siteId}/collections/${collection.name}/items/${item.id}/revisions`} />
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  siteId,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  siteId: string;
}) {
  const v = value ?? '';
  switch (field.type) {
    case 'textarea':
      return (
        <div className="field">
          <label>{field.label}{field.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}</label>
          <textarea value={String(v)} onChange={(e) => onChange(e.target.value)} rows={4} />
        </div>
      );
    case 'richtext':
      return (
        <div className="field">
          <label>{field.label}{field.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}</label>
          <textarea
            value={String(v)}
            onChange={(e) => onChange(e.target.value)}
            rows={10}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
            placeholder="<p>HTML content…</p>"
          />
          <span className="muted text-sm">HTML body. Use semantic tags.</span>
        </div>
      );
    case 'boolean':
      return (
        <div className="field">
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(e.target.checked)} />
            {field.label}
          </label>
        </div>
      );
    case 'number':
      return (
        <div className="field">
          <label>{field.label}</label>
          <input type="number" value={v === '' ? '' : Number(v)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
        </div>
      );
    case 'date':
      return (
        <div className="field">
          <label>{field.label}</label>
          <input
            type="date"
            value={String(v).slice(0, 10)}
            onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
          />
        </div>
      );
    case 'image':
      return (
        <div className="field">
          <label>{field.label}</label>
          <MediaPicker
            value={typeof v === 'string' ? v : ''}
            onChange={(url) => onChange(url)}
            siteId={siteId}
          />
        </div>
      );
    case 'select':
      return (
        <div className="field">
          <label>{field.label}</label>
          <select value={String(v)} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      );
    case 'email':
      return (
        <div className="field">
          <label>{field.label}</label>
          <input type="email" value={String(v)} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'url':
      return (
        <div className="field">
          <label>{field.label}</label>
          <input type="url" value={String(v)} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    default:
      return (
        <div className="field">
          <label>{field.label}{field.required && <span style={{ color: 'var(--color-danger)' }}> *</span>}</label>
          <input type="text" value={String(v)} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} />
        </div>
      );
  }
}
