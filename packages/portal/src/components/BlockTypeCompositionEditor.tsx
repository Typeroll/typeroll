// Blocks tab of the block type builder (composed mode): the block tree a
// composed block type renders, edited with the page editor's library, tree
// and inspector. Next to each bindable field of an inner block, "Bind to
// field" fills it from one of the type's fields (`{{props.name}}`), or,
// inside a repeater that loops over a list field, from the item
// (`{{item.name}}`).

import { useMemo, useState } from 'react';
import type { Block, BlockType, FieldDefinition } from '@typeroll/shared';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { GripVertical, Plus } from 'lucide-react';
import { BlockFieldForm, BlockLibrary, BlockTree, ICONS } from './BlockPageEditor';
import { useBlockDnd } from './block-dnd';
import {
  addBlockTo, duplicateBlockIn, findBlockIn, moveBlockIn, removeBlockFrom, setBlockNameIn, setStyleOverridesIn, updateBlockDataIn,
} from '../lib/block-tree-ops';
import { bindingOptions, describeBinding, isBindableField, itemScopeFor, parseBinding, propFieldFrom, suggestFieldName } from '../lib/block-type-builder';

const NEW_FIELD = '__new_field__';

export default function BlockTypeCompositionEditor({ siteId, composition, schema, registry, onChange, onSchemaChange }: {
  siteId: string;
  composition: Block[];
  schema: FieldDefinition[];
  /** Core and other site block types (never the type being edited). */
  registry: Map<string, BlockType>;
  onChange: (composition: Block[]) => void;
  onSchemaChange: (schema: FieldDefinition[]) => void;
}) {
  const [tab, setTab] = useState<'add' | 'structure'>(composition.length ? 'structure' : 'add');
  const [selectedId, setSelectedId] = useState<string | null>(composition[0]?.id ?? null);
  const selected = selectedId ? findBlockIn(composition, selectedId) : null;
  const customTypes = useMemo(() => [...registry.values()].filter(type => type.origin === 'user' || type.origin === 'third_party'), [registry]);

  const newBlock = (typeId: string): Block => {
    const type = registry.get(typeId);
    const data: Record<string, unknown> = {};
    for (const field of type?.schema ?? []) if (field.default !== undefined) data[field.name] = structuredClone(field.default);
    const block: Block = { id: '', type: typeId, data };
    // Containers hold children; a repeater without an item block repeats its children per item.
    if (type?.container === true || type?.container === 'repeater') block.children = [];
    if (type?.container === 'slots') block.slots = Array.from({ length: type.slot_count ?? 2 }, () => []);
    return block;
  };
  const add = (typeId: string, parentId: string | null, slot?: number, position?: number) => {
    const { tree, addedId } = addBlockTo(composition, newBlock(typeId), parentId, slot, position);
    onChange(tree);
    setSelectedId(addedId);
    setTab('structure');
  };
  const addToSelection = (typeId: string) => {
    const target = selected && (selected.block.children !== undefined || selected.block.slots !== undefined) ? selected.block.id : null;
    add(typeId, target, target ? 0 : undefined);
  };
  const dnd = useBlockDnd({
    blocks: composition,
    registry,
    icons: ICONS,
    onAdd: (typeId, parentId, slot, position) => add(typeId, parentId, slot, position),
    onMove: (id, parentId, slot, position) => onChange(moveBlockIn(composition, id, parentId, slot, position ?? 0)),
    onNewDragStart: () => setTab('structure'),
  });

  /** A new field modelled on an inner field, bound in place. */
  const addField = (field: FieldDefinition, item: ReturnType<typeof itemScopeFor>): string => {
    if (item) {
      const arrayName = schema.find(candidate => candidate.type === 'array' && candidate.fields === item.fields)?.name;
      const array = schema.find(candidate => candidate.name === arrayName)!;
      const name = suggestFieldName(field.label, (array.fields ?? []).map(sub => sub.name));
      onSchemaChange(schema.map(candidate => candidate === array ? { ...array, fields: [...(array.fields ?? []), propFieldFrom(field, name, field.label)] } : candidate));
      return `{{item.${name}}}`;
    }
    const name = suggestFieldName(field.label, schema.map(candidate => candidate.name));
    onSchemaChange([...schema, propFieldFrom(field, name, field.label)]);
    return `{{props.${name}}}`;
  };

  const decorate = (block: Block) => (field: FieldDefinition, value: unknown, set: (value: unknown) => void, control: React.ReactNode): React.ReactNode => {
    if (!isBindableField(field)) return control;
    const item = itemScopeFor(composition, block.id, schema);
    const scope = { props: schema, item: item?.fields, itemLabel: item?.label };
    const binding = parseBinding(value);
    if (binding) {
      return (
        <div className="bb-bound">
          <span className="bb-bound__label">{field.label}</span>
          <span className="bb-bound__value">
            <span>Filled from <strong>{describeBinding(binding, scope)}</strong></span>
            <button type="button" aria-label={`Unbind ${field.label}`} onClick={() => set(undefined)}>Unbind</button>
          </span>
        </div>
      );
    }
    const options = bindingOptions(field, scope);
    return (
      <>
        {control}
        <div className="bb-bind">
          <select aria-label={`Bind ${field.label} to a field`} value="" onChange={event => {
            const choice = event.target.value;
            if (!choice) return;
            set(choice === NEW_FIELD ? addField(field, item) : choice);
          }}>
            <option value="">Bind to field…</option>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            {field.type !== 'array' && <option value={NEW_FIELD}>New field “{field.label}”{item ? ` in ${item.label}` : ''}</option>}
          </select>
        </div>
      </>
    );
  };

  return (
    <div className="bb-compose">
      <DndContext {...dnd.contextProps}>
        <div className="bb-compose__left">
          <div className="bb-compose__tabs" role="tablist" aria-label="Blocks">
            <button type="button" role="tab" aria-selected={tab === 'add'} onClick={() => setTab('add')}><Plus size={14} aria-hidden="true" /> Add</button>
            <button type="button" role="tab" aria-selected={tab === 'structure'} onClick={() => setTab('structure')}><GripVertical size={14} aria-hidden="true" /> Structure</button>
          </div>
          <div>
            {tab === 'add'
              ? <BlockLibrary registry={registry} customTypes={customTypes} onAdd={addToSelection} />
              : <BlockTree blocks={composition} selectedId={selectedId} onSelect={setSelectedId}
                onRemove={id => { if (confirm('Remove this block and everything inside it?')) { onChange(removeBlockFrom(composition, id)); if (selectedId === id) setSelectedId(null); } }}
                onDuplicate={id => { const { tree, copyId } = duplicateBlockIn(composition, id); onChange(tree); if (copyId) setSelectedId(copyId); }}
                onRename={(id, name) => onChange(setBlockNameIn(composition, id, name))}
                registry={registry} dropTarget={dnd.dropTarget} />}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>{dnd.overlay}</DragOverlay>
      </DndContext>
      <section className="bb-compose__inspector" aria-label="Selected block">
        {selected ? (
          <BlockFieldForm
            key={selected.block.id}
            siteId={siteId}
            block={selected.block}
            blockType={registry.get(selected.block.type) ?? null}
            onChange={data => {
              const clean = { ...data };
              const removed = Object.keys(clean).filter(key => clean[key] === null);
              for (const key of removed) delete clean[key];
              let tree = updateBlockDataIn(composition, selected.block.id, clean);
              if (removed.length) {
                const found = findBlockIn(tree, selected.block.id);
                if (found) for (const key of removed) delete found.block.data[key];
              }
              onChange(tree);
            }}
            onStyleOverrides={async overrides => onChange(setStyleOverridesIn(composition, selected.block.id, overrides))}
            fieldDecorator={decorate(selected.block)}
          />
        ) : (
          <p className="bb-help">Select a block under Structure to set its fields, or add one. Bind a field to let people fill it in when they place this block; everything else stays as you set it here.</p>
        )}
      </section>
    </div>
  );
}
