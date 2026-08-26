// Top-level UI for managing per-site custom block types.
// Sidebar with list + "Ny blocktyp" button; selecting one opens
// BlockTypeEditor in the main area.

import { useEffect, useState } from 'react';
import type { BlockType } from '@typeroll/shared';
import { Plus, Box } from 'lucide-react';
import BlockTypeEditor from './BlockTypeEditor';

export default function BlockTypeManager({ siteId }: { siteId: string }) {
  const [types, setTypes] = useState<BlockType[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh(): Promise<BlockType[]> {
    const res = await fetch(`/api/sites/${siteId}/blocks/types`);
    if (!res.ok) return [];
    const body = await res.json() as { block_types: BlockType[] };
    setTypes(body.block_types ?? []);
    return body.block_types ?? [];
  }

  useEffect(() => { void refresh(); }, [siteId]);

  const selected = creating ? null : (types.find((t) => t.id === selectedId) ?? null);

  return (
    <div style={shell}>
      <aside style={sidebar}>
        <button
          type="button"
          onClick={() => { setCreating(true); setSelectedId(null); }}
          style={newBtn}
        >
          <Plus size={14} /> Ny blocktyp
        </button>
        <h3 style={listHeading}>Egna block</h3>
        {types.length === 0 && (
          <p style={emptyMsg}>No custom blocks yet.</p>
        )}
        <ul style={list}>
          {types.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => { setCreating(false); setSelectedId(t.id); }}
                style={listItem(selectedId === t.id && !creating)}
              >
                <Box size={14} />
                <span style={{ flex: 1, textAlign: 'left' }}>{t.label}</span>
                {t.origin === 'third_party' && (
                  <span style={originPill}>3rd</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main style={main}>
        {creating || selected !== null ? (
          <BlockTypeEditor
            siteId={siteId}
            blockType={selected}
            onSaved={async (saved) => {
              const next = await refresh();
              setCreating(false);
              setSelectedId(saved.id);
            }}
            onDeleted={(id) => {
              setSelectedId(null);
              setCreating(false);
              setTypes((ts) => ts.filter((t) => t.id !== id));
            }}
          />
        ) : (
          <div style={emptyState}>
            <Box size={32} />
            <h2 style={{ margin: '1rem 0 0' }}>Egna block</h2>
            <p style={muted}>Create reusable blocks for this site.</p>
          </div>
        )}
      </main>
    </div>
  );
}

const shell: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '260px 1fr', minHeight: 'calc(100vh - 64px)',
  background: '#0f0f12', color: '#e4e4e7',
};
const sidebar: React.CSSProperties = {
  padding: '1rem', borderRight: '1px solid #2a2a30', overflow: 'auto',
};
const newBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  width: '100%', padding: '.5rem', background: '#6366f1', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const listHeading: React.CSSProperties = {
  fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '0.05em',
  opacity: 0.55, margin: '1.5rem 0 .5rem',
};
const list: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0 };
const listItem = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 8,
  width: '100%', padding: '.4rem .6rem',
  background: active ? '#1f1f3d' : 'transparent',
  color: '#fafafa', border: 'none', borderRadius: 4, cursor: 'pointer',
  fontSize: '.85rem',
});
const originPill: React.CSSProperties = {
  fontSize: '.65rem', padding: '0 6px', background: '#3b2410', color: '#fbbf24',
  borderRadius: 999,
};
const emptyMsg: React.CSSProperties = { color: '#a1a1aa', fontSize: '.85rem' };
const main: React.CSSProperties = { overflow: 'auto' };
const emptyState: React.CSSProperties = {
  textAlign: 'center', padding: '5rem 2rem', color: '#a1a1aa',
};
const muted: React.CSSProperties = { color: '#a1a1aa', fontSize: '.9rem' };
