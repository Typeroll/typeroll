import { useId, useMemo, useState } from 'react';
import type { Block } from '@typeroll/shared';
import { suggestTypeName, type PropCandidate, type PropPick } from '../lib/block-type-builder';

export interface TurnIntoBlockTypeAction {
  /** Inner-block fields that can become the new type's fields (lib/block-type-builder propCandidates). */
  candidates: PropCandidate[];
  /** Block type names already taken on the Site. */
  takenNames: string[];
  submit(input: { name: string; label: string; picks: PropPick[] }): Promise<void>;
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/**
 * The "Turn into block type…" form: the selected block and its children
 * become a composed block type. The author ticks which inner fields people
 * fill in when they place it; everything else stays fixed.
 */
export default function TurnIntoBlockType({ block, action, onDone }: { block: Block; action: TurnIntoBlockTypeAction; onDone: (label: string) => void }) {
  const [label, setLabel] = useState(block.name?.trim() || 'New block type');
  const [name, setName] = useState<string | null>(null);
  const [rows, setRows] = useState(() => action.candidates.map(candidate => ({ ...candidate, include: true })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const nameId = useId();
  const autoName = useMemo(() => suggestTypeName(label, action.takenNames), [label, action.takenNames]);
  const typeName = name ?? autoName;
  const update = (index: number, patch: Partial<(typeof rows)[number]>) => setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const picks = rows.filter(row => row.include).map(row => ({ blockId: row.blockId, fieldName: row.field.name, name: row.name.trim(), label: row.label.trim() || row.field.label }));
    const names = picks.map(pick => pick.name);
    if (names.some(n => !/^[a-z][a-z0-9_]{0,63}$/.test(n))) { setError('Field names are lowercase letters, digits and "_", starting with a letter.'); return; }
    if (new Set(names).size !== names.length) { setError('Each field needs its own name.'); return; }
    setBusy(true);
    setError(null);
    try {
      await action.submit({ name: typeName, label: label.trim(), picks });
      onDone(label.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="turn-into" onSubmit={submit} aria-label="Turn into block type">
      <p>The block and everything inside it become a new block type for this Site. Its layout and styles stay as they are; people fill in the fields you choose here.</p>
      <label htmlFor={labelId} className="turn-into__label">Block type name</label>
      <input id={labelId} className="turn-into__input" value={label} required maxLength={120} onChange={e => setLabel(e.target.value)} />
      <label htmlFor={nameId} className="turn-into__label">Name used by the API and agents</label>
      <input id={nameId} className="turn-into__input" value={typeName} required pattern="[a-z0-9][a-z0-9_\-]{0,63}" spellCheck={false}
        onChange={e => setName(e.target.value)} aria-describedby={`${nameId}-help`} />
      <p id={`${nameId}-help`} className="turn-into__help">Lowercase letters, digits, "-" and "_". It cannot change later.</p>
      <fieldset className="turn-into__fields">
        <legend>Fields people can edit</legend>
        {rows.length === 0 && <p className="turn-into__help">These blocks have no text, links or images to offer as fields. The block type will have no fields; its content stays fixed.</p>}
        {rows.map((row, index) => (
          <div key={`${row.blockId}:${row.field.name}`} className="turn-into__row">
            <label className="turn-into__check">
              <input type="checkbox" checked={row.include} onChange={e => update(index, { include: e.target.checked })} />
              <span><strong>{row.blockLabel}</strong> · {row.field.label}<span className="turn-into__value">{preview(row.value)}</span></span>
            </label>
            {row.include && <div className="turn-into__pair">
              <label>Field label<input className="turn-into__input" value={row.label} onChange={e => update(index, { label: e.target.value })} /></label>
              <label>Field name<input className="turn-into__input" value={row.name} spellCheck={false} onChange={e => update(index, { name: e.target.value })} /></label>
            </div>}
          </div>
        ))}
        <p className="turn-into__help">Unticked values stay fixed in the block type, the same on every page.</p>
      </fieldset>
      {error && <p role="alert" className="turn-into__error">{error}</p>}
      <button type="submit" className="btn" disabled={busy || !label.trim()}>{busy ? 'Creating…' : 'Create block type'}</button>
      <style>{`
.turn-into { display: grid; gap: 6px; margin-top: .75rem; }
.turn-into > p, .turn-into__help { font-size: .8rem; color: #d4d4d8; margin: 0; }
.turn-into__label, .turn-into__pair label { font-size: .75rem; color: #d4d4d8; display: grid; gap: 2px; }
.turn-into__input { width: 100%; padding: .35rem .55rem; border-radius: 6px; background: #1f1f23; color: #fafafa; border: 1px solid #3a3a42; font-size: .85rem; }
.turn-into__fields { border: 1px solid #3a3a42; border-radius: 8px; padding: 8px 10px; display: grid; gap: 8px; min-width: 0; margin: 4px 0; }
.turn-into__fields legend { font-size: .8rem; font-weight: 600; color: #fafafa; padding: 0 4px; }
.turn-into__row { display: grid; gap: 4px; min-width: 0; }
.turn-into__check { display: flex; gap: 8px; align-items: flex-start; font-size: .82rem; color: #fafafa; }
.turn-into__check input { margin-top: 3px; }
.turn-into__value { display: block; color: #d4d4d8; font-size: .75rem; overflow-wrap: anywhere; }
.turn-into__pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding-left: 22px; }
.turn-into__error { color: #fca5a5; font-size: .82rem; margin: 0; }
.turn-into .btn { justify-self: start; background: #4f46e5; color: #fff; }
.turn-into .btn:hover:not(:disabled) { background: #4338ca; }
`}</style>
    </form>
  );
}
