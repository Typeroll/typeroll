// Site settings → Handover: the checklist, the structure lock, the start
// page and "Mark as handed over" (SiteSettings.handover). Administrators and
// builders only. Saves the whole object through PATCH
// /api/sites/{siteId}/settings { handover }; Remove sends null.

import { useState } from 'react';
import { handoverProgress, siteHandoverErrors, type HandoverChecklistItem, type SiteHandover } from '@typeroll/shared';

export interface HandoverEditorProps {
  siteId: string;
  initial: SiteHandover | null;
  pages: Array<{ id: string; title: string; path?: string }>;
}

/** A checklist item id from its label, unique among the others. */
export function checklistItemId(label: string, taken: readonly string[]): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export default function HandoverEditor({ siteId, initial, pages }: HandoverEditorProps) {
  const [handover, setHandover] = useState<SiteHandover>(initial ?? {});
  const [exists, setExists] = useState(initial !== null);
  const [label, setLabel] = useState('');
  const [href, setHref] = useState('');
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const items = handover.checklist ?? [];
  const progress = handoverProgress(handover);

  const update = (next: SiteHandover) => { setHandover(next); setStatus(null); };
  const setItems = (next: HandoverChecklistItem[]) => update({ ...handover, checklist: next });
  const move = (index: number, by: number) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
    setItems(next);
  };

  async function save(value: SiteHandover | null, done: string) {
    const errors = siteHandoverErrors(value);
    if (errors.length) { setStatus({ text: errors.join(' '), error: true }); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/settings`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ handover: value }),
      });
      const body = await res.json().catch(() => ({})) as { handover?: SiteHandover | null; error?: string };
      if (!res.ok) { setStatus({ text: body.error ?? `Saving failed (${res.status})`, error: true }); return; }
      setHandover(body.handover ?? {});
      setExists(body.handover != null);
      setStatus({ text: done });
    } catch (error) {
      setStatus({ text: (error as Error).message || 'Saving failed', error: true });
    } finally { setBusy(false); }
  }

  const clean = (value: SiteHandover): SiteHandover => ({
    ...(value.lock_structure ? { lock_structure: true } : {}),
    ...(value.start_page ? { start_page: value.start_page } : {}),
    ...(value.checklist?.length ? { checklist: value.checklist } : {}),
    ...(value.handed_over_at ? { handed_over_at: value.handed_over_at } : {}),
  });

  return (
    <div className="stack handover-editor" data-handover-editor>
      <div className="card stack">
        <h2 style={{ fontSize: '1.125rem', margin: 0 }}>Structure and start page</h2>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={!!handover.lock_structure} onChange={e => update({ ...handover, lock_structure: e.target.checked })} />
          <span>Lock the structure for editors<br /><span className="muted text-sm">People without design rights edit text and images, but cannot add, remove or move blocks, or create or delete pages. Administrators and builders are never locked.</span></span>
        </label>
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span>Start page</span>
          <select value={handover.start_page ?? ''} onChange={e => update({ ...handover, start_page: e.target.value || undefined })}>
            <option value="">No start page</option>
            {pages.map(page => <option key={page.id} value={page.id}>{page.title || page.id}{page.path ? ` (${page.path})` : ''}</option>)}
          </select>
          <span className="muted text-sm">Editors see a link to it first on the site overview.</span>
        </label>
      </div>

      <div className="card stack">
        <h2 style={{ fontSize: '1.125rem', margin: 0 }}>Checklist <span className="muted text-sm">· {progress.done} of {progress.total} done</span></h2>
        {items.length === 0 && <p className="muted text-sm" style={{ margin: 0 }}>No items yet. Add what the client should check or do, such as "Replace the sample photos" or "Connect the domain".</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((item, index) => (
            <li key={item.id} data-checklist-item={item.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.35rem 0', borderTop: '1px solid var(--color-border)' }}>
              <input type="checkbox" aria-label={`Done: ${item.label}`} checked={!!item.done} onChange={e => setItems(items.map(other => other.id === item.id ? { ...other, done: e.target.checked } : other))} />
              <span style={{ flex: 1 }}>{item.label}{item.href && <span className="muted text-sm"> · {item.href}</span>}</span>
              <button type="button" className="btn btn--secondary" aria-label={`Move up: ${item.label}`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" className="btn btn--secondary" aria-label={`Move down: ${item.label}`} disabled={index === items.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" className="btn btn--secondary" aria-label={`Remove: ${item.label}`} onClick={() => setItems(items.filter(other => other.id !== item.id))}>Remove</button>
            </li>
          ))}
        </ul>
        <form className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }} onSubmit={e => {
          e.preventDefault();
          if (!label.trim()) return;
          setItems([...items, { id: checklistItemId(label, items.map(item => item.id)), label: label.trim(), ...(href.trim() ? { href: href.trim() } : {}) }]);
          setLabel(''); setHref('');
        }}>
          <input aria-label="New checklist item" placeholder="e.g. Replace the sample photos" value={label} onChange={e => setLabel(e.target.value)} style={{ flex: '2 1 16rem' }} />
          <input aria-label="Portal link (optional)" placeholder={`/app/sites/${siteId}/media`} value={href} onChange={e => setHref(e.target.value)} style={{ flex: '1 1 12rem' }} />
          <button type="submit" className="btn btn--secondary" disabled={!label.trim()}>Add item</button>
        </form>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void save(clean(handover), 'Handover saved.')}>Save handover</button>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void save(clean({ ...handover, handed_over_at: new Date().toISOString() }), 'Marked as handed over.')}>
          {handover.handed_over_at ? 'Mark as handed over again' : 'Mark as handed over'}
        </button>
        {exists && <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => { if (confirm('Remove the handover? The checklist is deleted and the structure is unlocked.')) void save(null, 'Handover removed.'); }}>Remove handover</button>}
        {handover.handed_over_at && <span className="muted text-sm">Handed over {new Date(handover.handed_over_at).toLocaleString()}</span>}
        {status && <span role="status" className="text-sm" style={status.error ? { color: 'var(--color-danger, #b91c1c)' } : undefined}>{status.text}</span>}
      </div>
    </div>
  );
}
