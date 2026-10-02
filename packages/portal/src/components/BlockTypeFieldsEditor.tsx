// Fields tab of the block type builder: a visual editor for `schema`. Fields
// can be added, reordered (drag or Move up/down), nested inside groups
// (array and object fields, up to MAX_FIELD_DEPTH levels) and configured
// with label, help, required, default, options, item label and item limits.

import { useId, useState } from 'react';
import { BLOCK_TYPE_FIELD_TYPES, MAX_FIELD_DEPTH, type FieldDefinition, type FieldType } from '@typeroll/shared';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { moveArrayItem } from '../lib/array-field-ops';
import { suggestFieldName } from '../lib/block-type-builder';

export const FIELD_TYPE_LABELS: Partial<Record<FieldType, string>> = {
  text: 'Text', textarea: 'Long text', richtext: 'Formatted text', image: 'Image', icon: 'Icon', link: 'Link',
  url: 'Web address', email: 'Email address', number: 'Number', boolean: 'Yes / no', select: 'Choice',
  multiselect: 'Multiple choice', color: 'Colour', date: 'Date', datetime: 'Date and time',
  array: 'List of items (group)', object: 'Group of fields', style: 'Named style', page_ref: 'Page',
  page_ref_list: 'Pages', file: 'File', list: 'List of lines', list_simple: 'Simple list',
  block_type_ref: 'Block type', content_type_ref: 'Content type', global_block: 'Global block', choices: 'Form choices',
};
const COMMON_TYPES: FieldType[] = ['text', 'textarea', 'richtext', 'image', 'icon', 'link', 'select', 'boolean', 'number', 'array', 'object'];
const ORDERED_TYPES: FieldType[] = [...COMMON_TYPES, ...BLOCK_TYPE_FIELD_TYPES.filter(type => !COMMON_TYPES.includes(type))];

let fieldKeySeed = 0;
const nextFieldKey = () => `field-${++fieldKeySeed}`;

export default function BlockTypeFieldsEditor({ fields, onChange, depth = 1, title = 'Fields', problemsAt }: {
  fields: FieldDefinition[];
  onChange: (fields: FieldDefinition[]) => void;
  depth?: number;
  title?: string;
  /** Validator messages for a JSON pointer below this list, e.g. `/0/name`. */
  problemsAt?: (pointer: string) => string[];
}) {
  const [keys, setKeys] = useState<string[]>(() => fields.map(nextFieldKey));
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (keys.length !== fields.length) {
    // Fields changed from outside (JSON tab, starter): realign the keys.
    const next = fields.map((_, index) => keys[index] ?? nextFieldKey());
    setKeys(next.slice(0, fields.length));
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const update = (index: number, field: FieldDefinition) => onChange(fields.map((current, i) => i === index ? field : current));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= fields.length) return;
    setKeys(moveArrayItem(keys, from, to));
    onChange(moveArrayItem(fields, from, to));
  };
  const remove = (index: number) => {
    if (!confirm(`Remove the field “${fields[index]!.label}”? Placed blocks keep its value until you save; saving asks what to do with it.`)) return;
    setKeys(keys.filter((_, i) => i !== index));
    onChange(fields.filter((_, i) => i !== index));
  };
  const add = () => {
    const key = nextFieldKey();
    const name = suggestFieldName('field', fields.map(field => field.name));
    setKeys([...keys, key]);
    setOpen(current => new Set(current).add(key));
    onChange([...fields, { name, type: 'text', label: 'New field' }]);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const from = keys.indexOf(String(event.active.id));
    const to = event.over ? keys.indexOf(String(event.over.id)) : -1;
    if (from >= 0 && to >= 0) move(from, to);
  };

  return (
    <div className="bb-subfields-root">
      {fields.length === 0 && <p className="bb-help">No fields yet. Fields are what people fill in when they place this block.</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ol className="bb-fields" aria-label={title}>
            {fields.map((field, index) => (
              <FieldCard key={keys[index] ?? index} id={keys[index] ?? String(index)} field={field} siblings={fields} depth={depth}
                expanded={open.has(keys[index] ?? '')} first={index === 0} last={index === fields.length - 1}
                problems={problemsAt?.(`/${index}`) ?? []}
                childProblems={problemsAt ? (pointer: string) => problemsAt(`/${index}/fields${pointer}`) : undefined}
                onToggle={() => setOpen(current => { const next = new Set(current); const key = keys[index]!; if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                onChange={next => update(index, next)} onUp={() => move(index, index - 1)} onDown={() => move(index, index + 1)} onRemove={() => remove(index)} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <button type="button" className="bb-btn bb-btn--small" style={{ marginTop: 8 }} onClick={add}><Plus size={14} aria-hidden="true" /> Add field{depth > 1 ? ' to the group' : ''}</button>
    </div>
  );
}

function FieldCard({ id, field, siblings, depth, expanded, first, last, problems, childProblems, onToggle, onChange, onUp, onDown, onRemove }: {
  id: string; field: FieldDefinition; siblings: FieldDefinition[]; depth: number; expanded: boolean; first: boolean; last: boolean;
  problems: string[]; childProblems?: (pointer: string) => string[];
  onToggle: () => void; onChange: (field: FieldDefinition) => void; onUp: () => void; onDown: () => void; onRemove: () => void;
}) {
  const sortable = useSortable({ id });
  const uid = useId();
  const [nameTouched, setNameTouched] = useState(false);
  const set = (patch: Partial<FieldDefinition>) => {
    const next = { ...field, ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) if (value === undefined || (value === '' && key !== 'name' && key !== 'label')) delete next[key];
    onChange(next as unknown as FieldDefinition);
  };
  const setLabel = (label: string) => {
    // A new field's name follows its label until the name is edited.
    const auto = !nameTouched && /^field(_\d+)?$/.test(field.name);
    set({ label, ...(auto && label.trim() ? { name: suggestFieldName(label, siblings.filter(other => other !== field).map(other => other.name)) } : {}) });
  };
  const setType = (type: FieldType) => {
    const next: Partial<FieldDefinition> = { type, default: undefined };
    if ((type === 'select' || type === 'multiselect') && !field.options?.length) next.options = ['option_1', 'option_2'];
    if (type !== 'select' && type !== 'multiselect') { next.options = undefined; next.option_labels = undefined; }
    if (type === 'array' || type === 'object') { if (!field.fields?.length) next.fields = [{ name: 'title', type: 'text', label: 'Title' }]; }
    else next.fields = undefined;
    if (type !== 'array') { next.item_label = undefined; next.min_items = undefined; next.max_items = undefined; }
    set(next);
  };
  const style: React.CSSProperties = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, opacity: sortable.isDragging ? 0.6 : 1 };
  const isGroup = field.type === 'array' || field.type === 'object';
  return (
    <li ref={sortable.setNodeRef} style={style} className="bb-fieldcard">
      <div className="bb-fieldcard__head">
        <button type="button" className="bb-iconbtn bb-handle" aria-label={`Drag ${field.label} to reorder`} title="Drag to reorder" {...sortable.attributes} {...sortable.listeners}><GripVertical size={14} aria-hidden="true" /></button>
        <button type="button" className="bb-fieldcard__toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span className="bb-fieldcard__text">
            <span>{field.label || field.name}</span>
            <span className="bb-fieldcard__meta">{field.name} · {FIELD_TYPE_LABELS[field.type] ?? field.type}{field.required ? ' · required' : ''}</span>
          </span>
        </button>
        <button type="button" className="bb-iconbtn" aria-label={`Move ${field.label} up`} title="Move up" disabled={first} onClick={onUp}><ArrowUp size={14} aria-hidden="true" /></button>
        <button type="button" className="bb-iconbtn" aria-label={`Move ${field.label} down`} title="Move down" disabled={last} onClick={onDown}><ArrowDown size={14} aria-hidden="true" /></button>
        <button type="button" className="bb-iconbtn" aria-label={`Remove ${field.label}`} title="Remove" onClick={onRemove}><Trash2 size={14} aria-hidden="true" /></button>
      </div>
      {problems.length > 0 && <ul className="bb-problems" style={{ margin: '0 .5rem .5rem' }}>{problems.map((message, i) => <li key={i} className="is-error">{message}</li>)}</ul>}
      {expanded && (
        <div className="bb-fieldcard__body">
          <div className="bb-grid" style={{ paddingBottom: 0 }}>
            <label className="bb-field"><span>Label</span><input value={field.label} onChange={e => setLabel(e.target.value)} /></label>
            <label className="bb-field"><span>Name</span><input value={field.name} spellCheck={false} onChange={e => { setNameTouched(true); set({ name: e.target.value }); }} aria-describedby={`${uid}-name`} />
              <small id={`${uid}-name`}>Used in bindings and the API. Lowercase letters, digits and “_”.</small></label>
            <label className="bb-field"><span>Type</span>
              <select value={field.type} onChange={e => setType(e.target.value as FieldType)}>
                {ORDERED_TYPES.filter(type => depth < MAX_FIELD_DEPTH || (type !== 'array' && type !== 'object') || type === field.type)
                  .map(type => <option key={type} value={type}>{FIELD_TYPE_LABELS[type] ?? type}</option>)}
              </select></label>
            <label className="bb-field"><span>Editor group</span>
              <select value={field.editor_group ?? 'content'} onChange={e => set({ editor_group: e.target.value === 'content' ? undefined : e.target.value as FieldDefinition['editor_group'] })}>
                <option value="content">Content</option><option value="appearance">Appearance</option><option value="advanced">Advanced</option>
              </select></label>
          </div>
          <label className="bb-field"><span>Help text</span><input value={field.help ?? ''} placeholder="Shown under the field in the editor" onChange={e => set({ help: e.target.value })} /></label>
          <label className="bb-check"><input type="checkbox" checked={!!field.required} onChange={e => set({ required: e.target.checked || undefined })} /> Required</label>
          {!isGroup && <DefaultInput field={field} onChange={value => set({ default: value })} />}
          {(field.type === 'text' || field.type === 'textarea' || field.type === 'url' || field.type === 'email') && (
            <label className="bb-field"><span>Placeholder</span><input value={field.placeholder ?? ''} onChange={e => set({ placeholder: e.target.value })} /></label>
          )}
          {field.type === 'number' && <div className="bb-grid" style={{ paddingBottom: 0 }}>
            <label className="bb-field"><span>Lowest</span><input type="number" value={field.min ?? ''} onChange={e => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
            <label className="bb-field"><span>Highest</span><input type="number" value={field.max ?? ''} onChange={e => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
          </div>}
          {(field.type === 'select' || field.type === 'multiselect') && <OptionsEditor field={field} onChange={(options, labels) => set({ options, option_labels: labels })} />}
          {field.type === 'array' && <div className="bb-grid" style={{ paddingBottom: 0 }}>
            <label className="bb-field"><span>Item title</span>
              <select value={field.item_label ?? ''} onChange={e => set({ item_label: e.target.value || undefined })}>
                <option value="">First text field</option>
                {(field.fields ?? []).map(sub => <option key={sub.name} value={sub.name}>{sub.label}</option>)}
              </select><small>Titles each item when it is collapsed in the editor.</small></label>
            <label className="bb-field"><span>Fewest items</span><input type="number" min={0} max={500} value={field.min_items ?? ''} onChange={e => set({ min_items: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
            <label className="bb-field"><span>Most items</span><input type="number" min={0} max={500} value={field.max_items ?? ''} onChange={e => set({ max_items: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
          </div>}
          {isGroup && <div className="bb-subfields">
            <h4>{field.type === 'array' ? 'Fields of each item' : 'Fields in the group'}</h4>
            <BlockTypeFieldsEditor fields={field.fields ?? []} depth={depth + 1} title={`Fields of ${field.label}`} problemsAt={childProblems}
              onChange={fields => {
                const patch: Partial<FieldDefinition> = { fields };
                if (field.item_label && !fields.some(sub => sub.name === field.item_label)) patch.item_label = undefined;
                set(patch);
              }} />
          </div>}
        </div>
      )}
    </li>
  );
}

function DefaultInput({ field, onChange }: { field: FieldDefinition; onChange: (value: unknown) => void }) {
  const value = field.default;
  if (field.type === 'boolean') {
    return <label className="bb-field"><span>Default</span>
      <select value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value === 'yes')}>
        <option value="">None</option><option value="yes">Yes</option><option value="no">No</option>
      </select></label>;
  }
  if (field.type === 'select') {
    return <label className="bb-field"><span>Default</span>
      <select value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value || undefined)}>
        <option value="">None</option>
        {(field.options ?? []).map((option, index) => <option key={option} value={option}>{field.option_labels?.[index] ?? option}</option>)}
      </select></label>;
  }
  if (field.type === 'number') {
    return <label className="bb-field"><span>Default</span><input type="number" value={typeof value === 'number' ? value : ''} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} /></label>;
  }
  if (['text', 'textarea', 'richtext', 'icon', 'url', 'email', 'color', 'date', 'image'].includes(field.type)) {
    return <label className="bb-field"><span>Default</span><input value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value || undefined)}
      placeholder={field.type === 'icon' ? 'An icon name, e.g. check' : 'Value a new block starts with'} /></label>;
  }
  return null;
}

function OptionsEditor({ field, onChange }: { field: FieldDefinition; onChange: (options: string[], labels: string[] | undefined) => void }) {
  const options = field.options ?? [];
  const labels = options.map((_, index) => field.option_labels?.[index] ?? '');
  const write = (nextOptions: string[], nextLabels: string[]) => onChange(nextOptions, nextLabels.some(Boolean) ? nextOptions.map((option, index) => nextLabels[index] || option) : undefined);
  return (
    <fieldset className="bb-options" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="bb-field" style={{ padding: 0 }}><span>Options</span></legend>
      <p className="bb-help" style={{ margin: 0 }}>The value is stored; the label is what editors see.</p>
      {options.map((option, index) => (
        <div key={index} className="bb-options__row">
          <input aria-label={`Option ${index + 1} value`} value={option} spellCheck={false} onChange={e => write(options.map((o, i) => i === index ? e.target.value : o), labels)} />
          <input aria-label={`Option ${index + 1} label`} value={labels[index]} placeholder={option} onChange={e => write(options, labels.map((l, i) => i === index ? e.target.value : l))} />
          <button type="button" className="bb-iconbtn" aria-label={`Move option ${index + 1} up`} disabled={index === 0} onClick={() => write(moveArrayItem(options, index, index - 1), moveArrayItem(labels, index, index - 1))}><ArrowUp size={14} aria-hidden="true" /></button>
          <button type="button" className="bb-iconbtn" aria-label={`Move option ${index + 1} down`} disabled={index === options.length - 1} onClick={() => write(moveArrayItem(options, index, index + 1), moveArrayItem(labels, index, index + 1))}><ArrowDown size={14} aria-hidden="true" /></button>
          <button type="button" className="bb-iconbtn" aria-label={`Remove option ${index + 1}`} disabled={options.length <= 1} onClick={() => write(options.filter((_, i) => i !== index), labels.filter((_, i) => i !== index))}><Trash2 size={14} aria-hidden="true" /></button>
        </div>
      ))}
      <button type="button" className="bb-btn bb-btn--small" style={{ justifySelf: 'start' }} onClick={() => write([...options, `option_${options.length + 1}`], [...labels, ''])}><Plus size={14} aria-hidden="true" /> Add option</button>
    </fieldset>
  );
}
