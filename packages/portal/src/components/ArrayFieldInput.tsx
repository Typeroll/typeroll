import { useEffect, useId, useRef, useState } from 'react';
import type { FieldDefinition } from '@typeroll/shared';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, Copy, GripVertical, Trash2, ArrowUp, ArrowDown, Plus } from 'lucide-react';
import FieldInput from './FieldInput';
import { arrayItemTitle, arrayLimits, duplicateArrayItem, moveArrayItem, newArrayItem, removeArrayItem } from '../lib/array-field-ops';

let keySeed = 0;
const nextKey = () => `item-${++keySeed}`;

/**
 * A repeating group (`array` field with sub-fields): collapsible items titled
 * by `item_label`, with add, duplicate, remove (undoable), and reorder by
 * drag or with the Move up / Move down buttons. `min_items` / `max_items`
 * limit adding and removing.
 */
export default function ArrayFieldInput({
  siteId, field, value, onChange, label, help, triState, describedBy,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: unknown[];
  onChange: (value: unknown) => void;
  label: React.ReactNode;
  /** Help text, shown under the legend. */
  help?: React.ReactNode;
  triState?: boolean;
  describedBy?: string;
}) {
  const children = (field.fields ?? []).filter(child => child.name !== field.item_key);
  // Stable React keys that follow items through moves, so an open item stays open.
  const [keys, setKeys] = useState<string[]>(() => value.map(nextKey));
  const [open, setOpen] = useState<Set<string>>(() => new Set(value.length === 1 ? [keys[0]!] : []));
  const [removed, setRemoved] = useState<{ item: unknown; index: number; key: string; title: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const groupId = useId();
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    // The value changed from outside (another block, undo): keys no longer line up.
    if (keys.length !== value.length) setKeys(value.map(nextKey));
  }, [value.length]);
  useEffect(() => {
    if (!pendingFocus.current) return;
    document.getElementById(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const limits = arrayLimits(field, value.length);
  const titleOf = (index: number) => arrayItemTitle(field, value[index], index);
  const toggleId = (key: string) => `${groupId}-${key}-toggle`;

  if (children.length === 0) return null;

  const apply = (nextValue: unknown[], nextKeys: string[], message?: string) => {
    setKeys(nextKeys);
    onChange(nextValue);
    if (message) setAnnouncement(message);
  };
  const move = (from: number, to: number, focus?: 'up' | 'down') => {
    if (to < 0 || to >= value.length) return;
    const title = titleOf(from);
    apply(moveArrayItem(value, from, to), moveArrayItem(keys, from, to), `${title} moved to position ${to + 1} of ${value.length}.`);
    setRemoved(null);
    if (focus) pendingFocus.current = `${groupId}-${keys[from]}-${focus}`;
  };
  const add = () => {
    const key = nextKey();
    apply([...value, newArrayItem(field)], [...keys, key], `Item ${value.length + 1} added.`);
    setOpen(current => new Set(current).add(key));
    setRemoved(null);
    pendingFocus.current = toggleId(key);
  };
  const duplicate = (index: number) => {
    const key = nextKey();
    const nextKeys = keys.slice();
    nextKeys.splice(index + 1, 0, key);
    apply(duplicateArrayItem(value, index, field), nextKeys, `${titleOf(index)} duplicated.`);
    setOpen(current => new Set(current).add(key));
    setRemoved(null);
  };
  const remove = (index: number) => {
    const title = titleOf(index);
    setRemoved({ item: value[index], index, key: keys[index]!, title });
    apply(removeArrayItem(value, index), removeArrayItem(keys, index), `${title} removed.`);
  };
  const undo = () => {
    if (!removed) return;
    const nextValue = value.slice();
    nextValue.splice(Math.min(removed.index, nextValue.length), 0, removed.item);
    const nextKeys = keys.slice();
    nextKeys.splice(Math.min(removed.index, nextKeys.length), 0, removed.key);
    apply(nextValue, nextKeys, `${removed.title} restored.`);
    pendingFocus.current = toggleId(removed.key);
    setRemoved(null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const from = keys.indexOf(String(event.active.id));
    const to = event.over ? keys.indexOf(String(event.over.id)) : -1;
    if (from >= 0 && to >= 0 && from !== to) move(from, to);
  };

  return (
    <fieldset className="array-input" aria-describedby={describedBy}>
      <legend className="array-input__legend">{label}</legend>
      {help}
      <p className="array-input__meta">
        {value.length} {value.length === 1 ? 'item' : 'items'}{limits.hint ? ` · ${limits.hint}` : ''}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ol className="array-input__items">
            {value.map((raw, index) => {
              const key = keys[index] ?? `fallback-${index}`;
              const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
              const title = titleOf(index);
              return (
                <ArrayItem key={key} id={key} expanded={open.has(key)} title={title} toggleId={toggleId(key)} upId={`${groupId}-${key}-up`} downId={`${groupId}-${key}-down`}
                  first={index === 0} last={index === value.length - 1} canAdd={limits.canAdd} canRemove={limits.canRemove}
                  onToggle={() => setOpen(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                  onUp={() => move(index, index - 1, 'up')} onDown={() => move(index, index + 1, 'down')}
                  onDuplicate={() => duplicate(index)} onRemove={() => remove(index)}>
                  {children.map(child => (
                    <FieldInput key={child.name} siteId={siteId} triState={triState} field={child} value={row[child.name]}
                      onChange={next => {
                        const rows = value.slice();
                        rows[index] = { ...row, [child.name]: next };
                        onChange(rows);
                      }} />
                  ))}
                </ArrayItem>
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
      {removed && (
        <div className="array-input__undo" role="status">
          <span>Removed “{removed.title}”.</span>
          <button type="button" onClick={undo}>Undo</button>
        </div>
      )}
      <button type="button" className="array-input__add" disabled={!limits.canAdd} onClick={add}>
        <Plus size={14} aria-hidden="true" /> Add {field.label.toLowerCase().replace(/s$/, '') || 'item'}
      </button>
      {!limits.canAdd && <p className="array-input__meta">The most this list holds is {field.max_items}.</p>}
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
      <style>{ARRAY_INPUT_CSS}</style>
    </fieldset>
  );
}

function ArrayItem({ id, expanded, title, toggleId, upId, downId, first, last, canAdd, canRemove, onToggle, onUp, onDown, onDuplicate, onRemove, children }: {
  id: string; expanded: boolean; title: string; toggleId: string; upId: string; downId: string;
  first: boolean; last: boolean; canAdd: boolean; canRemove: boolean;
  onToggle: () => void; onUp: () => void; onDown: () => void; onDuplicate: () => void; onRemove: () => void;
  children: React.ReactNode;
}) {
  const sortable = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.6 : 1,
  };
  return (
    <li ref={sortable.setNodeRef} style={style} className="array-input__item" aria-label={title}>
      <div className="array-input__head">
        <button type="button" className="array-input__handle" aria-label={`Drag ${title} to reorder`} title="Drag to reorder" {...sortable.attributes} {...sortable.listeners}>
          <GripVertical size={14} aria-hidden="true" />
        </button>
        <button id={toggleId} type="button" className="array-input__toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span>{title}</span>
        </button>
        <span className="array-input__actions">
          <button id={upId} type="button" aria-label={`Move ${title} up`} title="Move up" disabled={first} onClick={onUp}><ArrowUp size={14} aria-hidden="true" /></button>
          <button id={downId} type="button" aria-label={`Move ${title} down`} title="Move down" disabled={last} onClick={onDown}><ArrowDown size={14} aria-hidden="true" /></button>
          <button type="button" aria-label={`Duplicate ${title}`} title="Duplicate" disabled={!canAdd} onClick={onDuplicate}><Copy size={14} aria-hidden="true" /></button>
          <button type="button" aria-label={`Remove ${title}`} title="Remove" disabled={!canRemove} onClick={onRemove}><Trash2 size={14} aria-hidden="true" /></button>
        </span>
      </div>
      {expanded && <div className="array-input__body">{children}</div>}
    </li>
  );
}

const ARRAY_INPUT_CSS = `
.array-input { margin: 0 0 .75rem; padding: 10px; border: 1px solid #3a3a42; border-radius: 8px; min-width: 0; }
.array-input__legend { padding: 0 4px; }
.array-input__legend label { opacity: 1 !important; color: #e4e4e7; font-weight: 600; }
.array-input__meta { margin: 0 0 .5rem; font-size: .75rem; color: #d4d4d8; }
.array-input__items { list-style: none; margin: 0 0 .5rem; padding: 0; display: grid; gap: 6px; }
.array-input__item { border: 1px solid #3a3a42; border-radius: 6px; background: #18181b; min-width: 0; }
.array-input__head { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 2px 4px; min-width: 0; }
.array-input__handle { display: inline-grid; place-items: center; width: 28px; height: 32px; padding: 0; border: 0; background: none; color: #d4d4d8; cursor: grab; touch-action: none; border-radius: 4px; }
.array-input__toggle { flex: 1 1 7rem; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 6px 4px; border: 0; background: none; color: #fafafa; cursor: pointer; text-align: left; font-size: .85rem; border-radius: 4px; }
.array-input__toggle span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.array-input__actions { display: inline-flex; gap: 2px; flex-shrink: 0; margin-left: auto; }
.array-input__actions button { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; background: none; color: #e4e4e7; cursor: pointer; border-radius: 4px; }
.array-input__actions button:hover:not(:disabled) { border-color: #52525b; background: #27272a; }
.array-input__actions button:disabled { color: #71717a; cursor: not-allowed; }
.array-input button:focus-visible { outline: 2px solid #818cf8; outline-offset: 1px; }
.array-input__body { padding: 8px 10px 4px; border-top: 1px solid #3a3a42; }
.array-input__add { display: inline-flex; align-items: center; gap: 6px; padding: .35rem .7rem; font-size: .8rem; border-radius: 6px; cursor: pointer; background: #27272a; color: #f4f4f5; border: 1px solid #52525b; }
.array-input__add:disabled { opacity: .6; cursor: not-allowed; }
.array-input__undo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 .5rem; padding: 6px 8px; border-radius: 6px; background: #1e1b4b; color: #e0e7ff; font-size: .8rem; }
.array-input__undo button { padding: .2rem .55rem; border-radius: 5px; border: 1px solid #a5b4fc; background: transparent; color: #e0e7ff; cursor: pointer; font-size: .8rem; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 1000px) {
  .array-input__actions button, .array-input__handle { width: 40px; height: 44px; }
  .array-input__toggle { min-height: 44px; }
}
`;
