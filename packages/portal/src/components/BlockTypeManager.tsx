// The Blocks page: the Site's own block types and the builder. New types start
// from a built-in starter, a blank composed or template type, or a copy of
// another of the Site's types. Admins only (the page checks permission).

import { useEffect, useMemo, useState } from 'react';
import { CORE_BLOCK_TYPES, type BlockType, type BlockTypeStarter, type SiteStyle } from '@typeroll/shared';
import { Box, Plus } from 'lucide-react';
import BlockTypeEditor from './BlockTypeEditor';
import { GlobalBlocksContext, RenderVersionContext, SiteStylesContext } from './editor-context';
import type { GlobalBlockSummary } from './editor-context';
import { blankComposedDefinition, blankTemplateDefinition, blockTypeMode, suggestTypeName } from '../lib/block-type-builder';
import './BlockPageEditor.css';
import './BlockTypeBuilder.css';

type View = { kind: 'empty' } | { kind: 'choose' } | { kind: 'new'; initial: Partial<BlockType>; seq: number } | { kind: 'edit'; id: string; notice?: string };

function readView(): View {
  if (typeof window === 'undefined') return { kind: 'empty' };
  const params = new URLSearchParams(window.location.search);
  const id = params.get('type');
  if (id) return { kind: 'edit', id };
  if (params.has('new')) return { kind: 'choose' };
  return { kind: 'empty' };
}

function writeUrl(view: View): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('type');
  url.searchParams.delete('new');
  if (view.kind === 'edit') url.searchParams.set('type', view.id);
  if (view.kind === 'choose' || view.kind === 'new') url.searchParams.set('new', '1');
  window.history.replaceState(null, '', url);
}

export default function BlockTypeManager({ siteId, siteStyles = [], renderVersion, globalBlocks = [] }: {
  siteId: string;
  siteStyles?: SiteStyle[];
  renderVersion?: number;
  globalBlocks?: GlobalBlockSummary[];
}) {
  const [types, setTypes] = useState<BlockType[] | null>(null);
  const [view, setViewState] = useState<View>({ kind: 'empty' });
  const setView = (next: View) => { setViewState(next); writeUrl(next); };
  useEffect(() => setViewState(readView()), []);

  async function refresh(): Promise<BlockType[]> {
    const res = await fetch(`/api/sites/${siteId}/blocks/types`);
    if (!res.ok) return [];
    const body = await res.json() as { block_types: BlockType[] };
    const list = (body.block_types ?? []).slice().sort((a, b) => a.label.localeCompare(b.label));
    setTypes(list);
    return list;
  }
  useEffect(() => { void refresh(); }, [siteId]);

  const registry = useMemo(() => {
    const map = new Map<string, BlockType>();
    for (const type of CORE_BLOCK_TYPES) map.set(type.id, type);
    for (const type of types ?? []) map.set(type.id, type);
    return map;
  }, [types]);
  const takenNames = useMemo(() => [...registry.values()].map(type => type.name).concat((types ?? []).map(type => type.id)), [registry, types]);
  const start = (definition: Partial<BlockType>) => {
    const initial = structuredClone(definition);
    if (initial.name) initial.name = suggestTypeName(initial.name, takenNames);
    setView({ kind: 'new', initial, seq: Date.now() });
  };
  const editing = view.kind === 'edit' ? types?.find(type => type.id === view.id) ?? null : null;

  return (
    <SiteStylesContext.Provider value={siteStyles}>
    <RenderVersionContext.Provider value={renderVersion ?? null}>
    <GlobalBlocksContext.Provider value={{ siteId, blocks: globalBlocks }}>
    <div className="block-builder">
      <aside className="bb-sidebar" aria-label="Block types">
        <button type="button" className="bb-new" onClick={() => setView({ kind: 'choose' })}><Plus size={14} aria-hidden="true" /> New block type</button>
        <h2 className="bb-list-heading">This Site's block types</h2>
        {types && types.length === 0 && <p className="bb-empty-note">None yet. Start from a starter, or turn a section on a page into one.</p>}
        <ul className="bb-list">
          {(types ?? []).map(type => (
            <li key={type.id}>
              <a href={`?type=${encodeURIComponent(type.id)}`} aria-current={view.kind === 'edit' && view.id === type.id ? 'page' : undefined}
                onClick={event => { event.preventDefault(); setView({ kind: 'edit', id: type.id }); }}>
                <Box size={14} aria-hidden="true" />
                <span className="bb-list__label">{type.label}</span>
                <span className="bb-pill">{type.origin === 'third_party' ? 'Extension' : blockTypeMode(type) === 'composed' ? 'Blocks' : 'Markup'}</span>
              </a>
            </li>
          ))}
        </ul>
      </aside>
      <main className="bb-main">
        {view.kind === 'choose' && <StarterChooser siteId={siteId} types={types ?? []} onChoose={start} />}
        {view.kind === 'new' && (
          <BlockTypeEditor key={`new-${view.seq}`} siteId={siteId} saved={null} initial={view.initial} registry={registry} renderVersion={renderVersion}
            onSaved={async saved => { await refresh(); setView({ kind: 'edit', id: saved.id, notice: 'Created. Add it to pages from the block library.' }); }}
            onDeleted={() => setView({ kind: 'empty' })} />
        )}
        {view.kind === 'edit' && (editing
          ? <BlockTypeEditor key={`edit-${editing.id}`} siteId={siteId} saved={editing} initial={editing} registry={registry} renderVersion={renderVersion} notice={view.notice}
            onSaved={async () => { await refresh(); }}
            onDeleted={id => { setTypes(list => (list ?? []).filter(type => type.id !== id)); setView({ kind: 'empty' }); }} />
          : <div className="bb-shell"><p className="bb-help">{types ? 'This block type does not exist on this Site.' : 'Loading…'}</p></div>)}
        {view.kind === 'empty' && (
          <div className="bb-shell" style={{ textAlign: 'center', paddingTop: '4rem' }}>
            <Box size={32} aria-hidden="true" style={{ margin: '0 auto' }} />
            <h2 style={{ margin: '1rem 0 .5rem', color: '#fafafa' }}>Block types</h2>
            <p className="bb-help" style={{ maxWidth: '36rem', margin: '0 auto 1rem' }}>
              Block types are this Site's own blocks: built from existing blocks or with your own markup, with fields that editors fill in on any page.
            </p>
            <button type="button" className="bb-btn bb-btn--primary" onClick={() => setView({ kind: 'choose' })}><Plus size={14} aria-hidden="true" /> New block type</button>
          </div>
        )}
      </main>
    </div>
    </GlobalBlocksContext.Provider>
    </RenderVersionContext.Provider>
    </SiteStylesContext.Provider>
  );
}

function StarterChooser({ siteId, types, onChoose }: { siteId: string; types: BlockType[]; onChoose: (definition: Partial<BlockType>) => void }) {
  const [starters, setStarters] = useState<BlockTypeStarter[] | null>(null);
  const [copyFrom, setCopyFrom] = useState('');
  useEffect(() => {
    fetch(`/api/sites/${siteId}/blocks/types/starters`)
      .then(res => res.ok ? res.json() as Promise<{ starters: BlockTypeStarter[] }> : { starters: [] })
      .then(body => setStarters(body.starters ?? []))
      .catch(() => setStarters([]));
  }, [siteId]);
  return (
    <div className="bb-shell">
      <header className="bb-header"><div><h2>New block type</h2><p>Choose a starting point. You can change everything afterwards.</p></div></header>
      <section className="bb-card" aria-labelledby="bb-start-blank">
        <h3 id="bb-start-blank">Start empty</h3>
        <div className="bb-starters">
          <button type="button" className="bb-starter" onClick={() => onChoose(blankComposedDefinition())}>
            <strong>Built from blocks</strong><span>Arrange headings, text, images, buttons and lists, then choose which of their fields editors fill in.</span><em>Recommended</em>
          </button>
          <button type="button" className="bb-starter" onClick={() => onChoose(blankTemplateDefinition())}>
            <strong>Own markup</strong><span>Write the HTML template and CSS yourself, for markup the existing blocks cannot express.</span><em>Advanced</em>
          </button>
        </div>
      </section>
      <section className="bb-card" aria-labelledby="bb-start-starter">
        <h3 id="bb-start-starter">Start from a starter</h3>
        {!starters ? <p>Loading…</p> : (
          <div className="bb-starters">
            {starters.map(starter => (
              <button key={starter.id} type="button" className="bb-starter" onClick={() => onChoose(starter.definition)}>
                <strong>{starter.label}</strong><span>{starter.description}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {types.length > 0 && (
        <section className="bb-card" aria-labelledby="bb-start-copy">
          <h3 id="bb-start-copy">Copy one of this Site's block types</h3>
          <div className="bb-actions">
            <select aria-label="Block type to copy" value={copyFrom} onChange={e => setCopyFrom(e.target.value)}>
              <option value="">Choose a block type…</option>
              {types.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}
            </select>
            <button type="button" className="bb-btn" disabled={!copyFrom} onClick={() => {
              const source = types.find(type => type.id === copyFrom);
              if (!source) return;
              const { id: _id, origin: _origin, created_at: _created, css_scope: _scope, ...rest } = structuredClone(source) as BlockType & { updated_at?: string };
              onChoose({ ...rest, name: `${source.name}_copy`, label: `${source.label} (copy)` });
            }}>Copy</button>
          </div>
        </section>
      )}
    </div>
  );
}
