// One site block type in the builder. Tabs:
//   Fields  — the schema (BlockTypeFieldsEditor)
//   Blocks  — composed types: the block tree and its bindings (BlockTypeCompositionEditor)
//   Markup  — template types: the template (BlockTypeMarkupEditor)
//   CSS     — the block's own stylesheet, scoped to the block
//   Preview — the server preview at three widths, with editable sample content
//   Usage   — pages, templates and global blocks placing it
//   JSON    — the full definition as the API takes it
//
// The shared validator (via the validate endpoint) checks the draft as it
// changes; saving validates again, and errors block the save. Removing or
// renaming fields that placed blocks use answers 409; the impact panel then
// maps old fields to new ones or confirms the data loss.

import { useEffect, useMemo, useState } from 'react';
import type { BlockType, BlockTypeProblem, FieldDefinition } from '@typeroll/shared';
import { AlertTriangle, Save, Trash2 } from 'lucide-react';
import BlockTypeFieldsEditor from './BlockTypeFieldsEditor';
import BlockTypeCompositionEditor from './BlockTypeCompositionEditor';
import BlockTypeMarkupEditor from './BlockTypeMarkupEditor';
import BlockTypePreview from './BlockTypePreview';
import CustomCssEditor from './CustomCssEditor';
import {
  blockTypeMode, compositionCssHints, detectRenames, renameBindings, schemaChanges, siblingPaths, suggestTypeName, templateCssHints, writableDefinition,
} from '../lib/block-type-builder';
import type { BlockTypeUsage } from '../lib/block-type-usage';
import type { BlockTypeImpact, ImpactUsage } from '../lib/block-type-migration';

type Tab = 'fields' | 'blocks' | 'markup' | 'css' | 'preview' | 'usage' | 'json';
const CATEGORIES = [['content', 'Content'], ['layout', 'Layout'], ['media', 'Media'], ['custom', 'Custom']] as const;

interface Props {
  siteId: string;
  /** The saved type, or null while creating one. */
  saved: BlockType | null;
  /** The starting definition while creating. */
  initial: Partial<BlockType>;
  /** Core and site block types, for the composition and its library. */
  registry: Map<string, BlockType>;
  renderVersion?: number;
  /** A message to start with, e.g. after the type was created. */
  notice?: string;
  onSaved: (type: BlockType) => void;
  onDeleted: (id: string) => void;
}

interface Impact {
  error: string;
  /** Places whose data the change would drop (from the server's impact report). */
  usages: ImpactUsage[];
  /** Old field paths that no longer exist, or changed type. */
  removed: string[];
  retyped: string[];
  /** New field paths, offered as rename targets. */
  added: string[];
}

function tabFor(path: string): Tab | null {
  if (path.startsWith('/schema') || path.startsWith('/renames')) return 'fields';
  if (path.startsWith('/composition')) return 'blocks';
  if (path.startsWith('/template')) return 'markup';
  if (path.startsWith('/styles')) return 'css';
  return null;
}

const USAGE_KIND_LABELS: Record<ImpactUsage['kind'], string> = {
  page: 'Page', page_draft: 'Page draft', page_template: 'Page template', partial: 'Global block', partial_draft: 'Global block draft',
  block_template: 'Block template', block_type: 'Block type',
};

function usageHref(siteId: string, usage: ImpactUsage): string | null {
  const id = encodeURIComponent(usage.id);
  if (usage.kind === 'page' || usage.kind === 'page_draft') return `/app/sites/${siteId}/pages/${id}`;
  if (usage.kind === 'partial' || usage.kind === 'partial_draft') return `/app/sites/${siteId}/partials/${id}`;
  if (usage.kind === 'page_template') return `/app/sites/${siteId}/templates/${id}`;
  if (usage.kind === 'block_type') return `/app/sites/${siteId}/blocks?type=${id}`;
  return null;
}

export default function BlockTypeEditor({ siteId, saved, initial, registry, renderVersion, notice, onSaved, onDeleted }: Props) {
  const isNew = !saved;
  const [draft, setDraft] = useState<Partial<BlockType>>(() => structuredClone(saved ?? initial));
  const mode = blockTypeMode(draft);
  const [tab, setTab] = useState<Tab>(isNew ? (mode === 'composed' ? 'blocks' : 'markup') : 'fields');
  const [problems, setProblems] = useState<BlockTypeProblem[]>([]);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>(notice ? { kind: 'saved', message: notice } : { kind: 'idle' });
  const [impact, setImpact] = useState<Impact | null>(null);
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [jsEnabled, setJsEnabled] = useState(!!saved?.script);
  const [usage, setUsage] = useState<BlockTypeUsage | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(!isNew);

  const set = <K extends keyof BlockType>(key: K, value: BlockType[K] | undefined) => setDraft(current => {
    const next = { ...current, [key]: value };
    if (value === undefined) delete next[key];
    return next;
  });
  const definition = useMemo(() => {
    const out = writableDefinition(jsEnabled ? draft : { ...draft, script: undefined });
    // Clearing a saved script must reach the server.
    if (!isNew && saved?.script && !out.script) out.script = '';
    return out;
  }, [draft, jsEnabled, isNew, saved?.script]);
  const definitionKey = JSON.stringify(definition);

  // Live validation through the shared validator.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/sites/${siteId}/blocks/types/validate${saved ? `?type_id=${encodeURIComponent(saved.id)}` : ''}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: definitionKey, signal: controller.signal,
        });
        if (!res.ok) return;
        const body = await res.json() as { problems?: BlockTypeProblem[] };
        setProblems(body.problems ?? []);
      } catch { /* aborted or offline: keep the last report */ }
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [siteId, saved?.id, definitionKey]);

  useEffect(() => {
    if (tab !== 'usage' || !saved) return;
    fetch(`/api/sites/${siteId}/blocks/types/usage?id=${encodeURIComponent(saved.id)}`)
      .then(res => res.ok ? res.json() as Promise<BlockTypeUsage> : null)
      .then(body => setUsage(body ?? { pages: [], templates: [], partials: [], block_templates: [], block_types: [] }))
      .catch(() => setUsage({ pages: [], templates: [], partials: [], block_templates: [], block_types: [] }));
  }, [tab, saved?.id, siteId]);

  useEffect(() => {
    if (tab === 'json') { setJsonText(JSON.stringify(definition, null, 2)); setJsonError(null); }
  }, [tab]);

  const errors = problems.filter(problem => problem.severity === 'error');
  const warnings = problems.filter(problem => problem.severity === 'warning');
  const countFor = (target: Tab) => errors.filter(problem => tabFor(problem.path) === target).length;
  /** Messages for one field card: its own path and its properties, not its sub-fields (they have their own cards). */
  const problemsAt = (prefix: string) => (pointer: string) => problems.filter(problem => {
    const base = `${prefix}${pointer}`;
    if (problem.path === base) return true;
    return problem.path.startsWith(`${base}/`) && !problem.path.slice(base.length + 1).startsWith('fields/');
  }).map(problem => problem.message);

  async function save(extra: { renames?: Record<string, string>; confirm_data_loss?: boolean } = {}) {
    setStatus({ kind: 'saving' });
    try {
      const check = await fetch(`/api/sites/${siteId}/blocks/types/validate${saved ? `?type_id=${encodeURIComponent(saved.id)}` : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(definition),
      });
      if (check.ok) {
        const report = await check.json() as { problems?: BlockTypeProblem[] };
        setProblems(report.problems ?? []);
        const blocking = (report.problems ?? []).filter(problem => problem.severity === 'error');
        if (blocking.length) {
          setStatus({ kind: 'error', message: `Fix ${blocking.length} ${blocking.length === 1 ? 'error' : 'errors'} before saving.` });
          const first = tabFor(blocking[0]!.path);
          if (first && (first !== 'blocks' || mode === 'composed') && (first !== 'markup' || mode === 'template')) setTab(first);
          return;
        }
      }
      const res = await fetch(saved ? `/api/sites/${siteId}/blocks/types?id=${encodeURIComponent(saved.id)}` : `/api/sites/${siteId}/blocks/types`, {
        method: saved ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...definition, ...extra }),
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.status === 409 && saved && body.impact) {
        const report = body.impact as BlockTypeImpact;
        const changes = schemaChanges(saved.schema ?? [], (draft.schema ?? []) as FieldDefinition[]);
        setImpact({
          error: String(body.error ?? 'This change affects blocks already placed.'),
          usages: report.usages ?? [],
          removed: report.removed ?? changes.removed,
          retyped: (report.retyped ?? []).map(entry => entry.path),
          added: changes.added,
        });
        // Fields renamed in place are offered as renames, so their data moves.
        const detected = detectRenames(saved.schema ?? [], (draft.schema ?? []) as FieldDefinition[]);
        setRenames(Object.fromEntries(Object.entries(detected).filter(([from]) => (report.removed ?? changes.removed).includes(from))));
        setStatus({ kind: 'idle' });
        return;
      }
      if (!res.ok) {
        if (Array.isArray(body.problems)) setProblems(body.problems as BlockTypeProblem[]);
        throw new Error(String(body.error ?? `Save failed (${res.status})`));
      }
      const result = body as { block_type?: BlockType; warnings?: BlockTypeProblem[]; impact?: BlockTypeImpact };
      if (!result.block_type) throw new Error('The server did not return the saved block type.');
      setImpact(null);
      const moved = result.impact?.renamed?.length ? ` Moved the data of ${result.impact.renamed.length} renamed ${result.impact.renamed.length === 1 ? 'field' : 'fields'}.` : '';
      setStatus({ kind: 'saved', message: isNew ? 'Created. Add it to pages from the block library.' : `Saved. Pages using it show the change; the live site updates at the next deploy.${moved}` });
      if (result.warnings) setProblems(result.warnings);
      onSaved(result.block_type);
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  }

  async function remove() {
    if (!saved || !confirm(`Delete the block type “${saved.label}”? This cannot be undone.`)) return;
    const res = await fetch(`/api/sites/${siteId}/blocks/types?id=${encodeURIComponent(saved.id)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({})) as { error?: string };
    if (res.ok) onDeleted(saved.id);
    else setStatus({ kind: 'error', message: body.error ?? `Delete failed (${res.status})` });
  }

  function applyJson() {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The definition must be a JSON object.');
      const next = parsed as Partial<BlockType>;
      if (saved && next.name !== undefined && next.name !== saved.name) throw new Error('A block type cannot be renamed. Create a new one instead.');
      setDraft({ ...(saved ? { id: saved.id, origin: saved.origin, created_at: saved.created_at } : {}), ...next });
      if (next.script) setJsEnabled(true);
      setJsonError(null);
      setStatus({ kind: 'idle', message: 'JSON applied. Save to keep it.' });
    } catch (e) {
      setJsonError((e as Error).message);
    }
  }

  const schema = (draft.schema ?? []) as FieldDefinition[];
  const otherTypes = useMemo(() => {
    const out = new Map(registry);
    if (draft.name) out.delete(draft.name);
    if (saved) out.delete(saved.id);
    return out;
  }, [registry, draft.name, saved?.id]);
  const cssHints = mode === 'composed' ? compositionCssHints(draft.composition ?? [], registry) : templateCssHints(draft.template ?? '');
  const tabs: Array<[Tab, string]> = [
    ['fields', 'Fields'],
    mode === 'composed' ? ['blocks', 'Blocks'] : ['markup', 'Markup'],
    ['css', 'CSS'], ['preview', 'Preview'], ['usage', 'Usage'], ['json', 'JSON'],
  ];

  return (
    <div className="bb-shell">
      <header className="bb-header">
        <div>
          <h2>{draft.label || (isNew ? 'New block type' : saved!.label)}</h2>
          <p>{isNew ? 'Not saved yet.' : <>Name <code>{saved!.id}</code></>} · {mode === 'composed' ? 'Built from blocks' : 'Own markup'}</p>
        </div>
        <div className="bb-actions">
          {status.kind === 'saving' && <span className="bb-status" role="status">Saving…</span>}
          {status.kind === 'saved' && <span className="bb-status bb-status--ok" role="status">{status.message}</span>}
          {status.kind === 'error' && <span className="bb-status bb-status--error" role="alert">{status.message}</span>}
          {status.kind === 'idle' && status.message && <span className="bb-status" role="status">{status.message}</span>}
          {!isNew && <button type="button" className="bb-btn bb-btn--danger" onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" /> Delete</button>}
          <button type="button" className="bb-btn bb-btn--primary" disabled={status.kind === 'saving'} onClick={() => void save()}><Save size={14} aria-hidden="true" /> {isNew ? 'Create block type' : 'Save'}</button>
        </div>
      </header>

      {impact && saved && (
        <section className="bb-impact" aria-labelledby="bb-impact-title">
          <h3 id="bb-impact-title"><AlertTriangle size={16} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-3px' }} /> Placed blocks use the fields you changed</h3>
          <p>{impact.error}</p>
          {impact.usages.length > 0 && <ul>{impact.usages.map((usage, i) => {
            const href = usageHref(siteId, usage);
            return <li key={i}>{USAGE_KIND_LABELS[usage.kind]}: {href ? <a href={href}>{usage.title || usage.id}</a> : usage.title || usage.id}
              {' '}({usage.instances} {usage.instances === 1 ? 'block' : 'blocks'}{usage.data_loss.length ? `; data in ${usage.data_loss.join(', ')}` : ''})</li>;
          })}</ul>}
          {[...impact.removed, ...impact.retyped].map(path => {
            const retyped = impact.retyped.includes(path);
            const choices = retyped ? [] : [...new Set([...siblingPaths(impact.added, path), ...(renames[path] ? [renames[path]!] : [])])];
            return (
              <div key={path} className="bb-impact__row">
                <span><code>{path}</code> {retyped ? 'changed type' : 'was removed or renamed'}</span>
                <select aria-label={`What happens to the data in ${path}`} value={renames[path] ?? ''} onChange={e => setRenames(current => ({ ...current, [path]: e.target.value }))}>
                  <option value="">Delete its data</option>
                  {choices.map(choice => <option key={choice} value={choice}>Move it to {choice}</option>)}
                </select>
              </div>
            );
          })}
          <div className="bb-actions" style={{ marginTop: '.75rem' }}>
            <button type="button" className="bb-btn bb-btn--primary" onClick={() => {
              // The API takes old dotted paths mapped to the field's new name.
              const mapped = Object.fromEntries(Object.entries(renames).filter(([, to]) => to).map(([from, to]) => [from, to.slice(to.lastIndexOf('.') + 1)]));
              const losesData = [...impact.removed, ...impact.retyped].some(path => !mapped[path]);
              void save({ ...(Object.keys(mapped).length ? { renames: mapped } : {}), ...(losesData ? { confirm_data_loss: true } : {}) });
            }}>Apply and save</button>
            <button type="button" className="bb-btn" onClick={() => setImpact(null)}>Keep editing</button>
          </div>
        </section>
      )}

      <details className="bb-details" open={isNew}>
        <summary>Name and settings</summary>
        <div className="bb-grid">
          <label className="bb-field"><span>Label</span>
            <input value={draft.label ?? ''} required maxLength={120} placeholder="Icon list" onChange={e => {
              const label = e.target.value;
              setDraft(current => ({ ...current, label, ...(isNew && !nameTouched ? { name: label.trim() ? suggestTypeName(label, [...registry.values()].map(type => type.name)) : '' } : {}) }));
            }} /><small>Shown in the block library.</small></label>
          <label className="bb-field"><span>Name</span>
            <input value={draft.name ?? ''} disabled={!isNew} spellCheck={false} placeholder="icon_list" onChange={e => { setNameTouched(true); set('name', e.target.value); }} />
            <small>{isNew ? 'Used by the API and agents. It cannot change later.' : 'Names cannot change.'}</small></label>
          <label className="bb-field"><span>Category</span>
            <select value={draft.category ?? 'custom'} onChange={e => set('category', e.target.value as BlockType['category'])}>
              {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          <label className="bb-field"><span>Library icon</span><input value={draft.icon ?? ''} placeholder="e.g. list" onChange={e => set('icon', e.target.value || undefined)} /></label>
        </div>
        <label className="bb-field" style={{ marginBottom: '.9rem' }}><span>When to use it</span>
          <input value={draft.description ?? ''} maxLength={500} placeholder="Shown to editors and agents" onChange={e => set('description', e.target.value || undefined)} /></label>
        {mode === 'template' && (
          <div className="bb-grid">
            <label className="bb-field"><span>Holds other blocks</span>
              <select value={String(draft.container ?? false)} onChange={e => {
                const value = e.target.value;
                set('container', value === 'true' ? true : value === 'false' ? false : value as BlockType['container']);
                // Slot containers need a slot count; start with two.
                if (value === 'slots' && !draft.slot_count) set('slot_count', 2);
              }}>
                <option value="false">No</option>
                <option value="true">Yes: a list of child blocks ({'{{children}}'})</option>
                <option value="slots">Yes: named slots ({'{{slot:name}}'})</option>
                <option value="repeater">Repeater: repeats an item block</option>
                <option value="conditional">Conditional: shown when a condition holds</option>
              </select></label>
            {draft.container === 'slots' && <>
              <label className="bb-field"><span>Number of slots</span><input type="number" min={1} max={8} value={draft.slot_count ?? 2} onChange={e => set('slot_count', Number(e.target.value))} /></label>
              <label className="bb-field"><span>Slot labels</span><input value={(draft.slot_labels ?? []).join(', ')} placeholder="Left, Right" onChange={e => set('slot_labels', e.target.value.split(',').map(label => label.trim()).filter(Boolean))} /></label>
            </>}
          </div>
        )}
        <label className="bb-check" style={{ marginBottom: '.9rem' }}>
          <input type="checkbox" checked={!!draft.item_compatible} onChange={e => set('item_compatible', e.target.checked ? true : undefined)} />
          Offer it as the item of a repeater
        </label>
        {draft.expand_to && <p className="bb-help">Expands to <code>{draft.expand_to.target}</code>. Edit <code>expand_to</code> in the JSON tab.</p>}
        {mode === 'template' && (
          <div style={{ paddingBottom: '.9rem' }}>
            {jsEnabled ? (
              <label className="bb-field"><span>Script</span>
                <textarea rows={6} value={draft.script ?? ''} spellCheck={false} style={{ fontFamily: 'var(--font-mono)' }}
                  placeholder={`window.TyperollBlocks.register('${draft.name || 'my_block'}', function (el, data) {\n  // runs for every instance on page load\n});`}
                  onChange={e => set('script', e.target.value)} />
                <small>Runs in every visitor's browser with full access to the page. It is not sanitized.</small></label>
            ) : (
              <button type="button" className="bb-btn bb-btn--small" onClick={() => {
                if (confirm('Block scripts run in every visitor’s browser with full access to the page, and are not sanitized. You are responsible for their security and performance. Add a script?')) setJsEnabled(true);
              }}>Add a script (advanced)…</button>
            )}
          </div>
        )}
      </details>

      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="bb-problems" aria-label="Problems">
          {[...errors, ...warnings].slice(0, 12).map((problem, i) => {
            const target = tabFor(problem.path);
            return <li key={i} className={`is-${problem.severity}`}>
              <strong>{problem.severity === 'error' ? 'Error' : 'Warning'}:</strong>
              {target ? <button type="button" onClick={() => setTab(target)}>{problem.message}{problem.line ? ` (line ${problem.line})` : ''}</button> : <span>{problem.message}</span>}
            </li>;
          })}
        </ul>
      )}

      <div className="bb-tabs" role="tablist" aria-label="Block type">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" id={`bb-tab-${key}`} aria-selected={tab === key} aria-controls="bb-tabpanel" onClick={() => setTab(key)}>
            {label}{countFor(key) > 0 && <span className="bb-count" aria-label={`${countFor(key)} errors`}>{countFor(key)}</span>}
          </button>
        ))}
      </div>

      <div id="bb-tabpanel" role="tabpanel" aria-labelledby={`bb-tab-${tab}`} className="bb-panel">
        {tab === 'fields' && <BlockTypeFieldsEditor fields={schema} problemsAt={problemsAt('/schema')} onChange={fields => setDraft(current => {
          // Bindings follow a field whose name was edited in place.
          const renames = detectRenames((current.schema ?? []) as FieldDefinition[], fields);
          return { ...current, schema: fields, ...(current.composition && Object.keys(renames).length ? { composition: renameBindings(current.composition, renames) } : {}) };
        })} />}
        {tab === 'blocks' && mode === 'composed' && (
          <BlockTypeCompositionEditor siteId={siteId} composition={draft.composition ?? []} schema={schema} registry={otherTypes}
            onChange={composition => set('composition', composition)} onSchemaChange={fields => set('schema', fields)} />
        )}
        {tab === 'markup' && mode === 'template' && (
          <BlockTypeMarkupEditor value={draft.template ?? ''} schema={schema} blockName={draft.name ?? ''}
            problems={problems.filter(problem => problem.path === '/template')} onChange={template => set('template', template)} />
        )}
        {tab === 'css' && (
          <CustomCssEditor
            label="Block CSS"
            value={draft.styles ?? ''}
            onText={css => set('styles', css)}
            ignoreCodes={['platform_selector']}
            extraProblems={problems.filter(problem => problem.path === '/styles').map(problem => ({ severity: problem.severity, message: problem.message, line: problem.line }))}
            classHints={cssHints}
            placeholder={':scope { display: grid; gap: 1rem; }\n.card { padding: 1rem; }'}
            help={<>
              Every selector is scoped to this block: <code>.card</code> ships as <code>[data-block="{draft.name || 'name'}"] .card</code>, so it never styles anything outside the block. <code>:scope</code> is the block itself. <code>:root</code>, <code>html</code> and <code>body</code> are refused. Use the Site's design values, e.g. <code>var(--color-primary)</code>.
            </>}
          />
        )}
        {tab === 'preview' && <BlockTypePreview siteId={siteId} definition={definition} schema={schema} renderVersion={renderVersion} />}
        {tab === 'usage' && (
          <div className="bb-card">
            <h3>Where it is used</h3>
            {!saved ? <p>Save the block type first; then place it on pages from the block library.</p>
              : !usage ? <p>Loading…</p>
              : usage.pages.length + usage.templates.length + usage.partials.length + (usage.block_templates?.length ?? 0) + (usage.block_types?.length ?? 0) === 0 ? <p>Not placed anywhere yet. Add it to a page from the block library.</p>
              : <>
                {usage.pages.length > 0 && <><p>Pages</p><ul>{usage.pages.map(page => <li key={page.page_id}><a href={`/app/sites/${siteId}/pages/${encodeURIComponent(page.page_id)}`}>{page.title || page.page_id}</a> <span className="bb-help">· {page.status}{page.sources?.includes('draft') && !page.sources.includes('saved') ? ', draft only' : ''}{page.via?.length ? `, through ${page.via.join(', ')}` : ''}</span></li>)}</ul></>}
                {usage.templates.length > 0 && <><p>Page templates</p><ul>{usage.templates.map(template => <li key={template.template_id}><a href={`/app/sites/${siteId}/templates/${encodeURIComponent(template.template_id)}`}>{template.name || template.template_id}</a></li>)}</ul></>}
                {usage.partials.length > 0 && <><p>Global blocks, header and footer</p><ul>{usage.partials.map(partial => <li key={partial.partial_id}><a href={`/app/sites/${siteId}/partials/${encodeURIComponent(partial.partial_id)}`}>{partial.name || partial.partial_id}</a> <span className="bb-help">· {partial.kind ?? 'global block'}</span></li>)}</ul></>}
                {(usage.block_templates?.length ?? 0) > 0 && <><p>Block templates</p><ul>{usage.block_templates.map(template => <li key={template.block_template_id}>{template.name}</li>)}</ul></>}
                {(usage.block_types?.length ?? 0) > 0 && <><p>Other block types built from it</p><ul>{usage.block_types.map(type => <li key={type.type_id}><a href={`/app/sites/${siteId}/blocks?type=${encodeURIComponent(type.type_id)}`}>{type.label}</a></li>)}</ul></>}
              </>}
          </div>
        )}
        {tab === 'json' && (
          <div className="bb-card">
            <h3>Definition</h3>
            <p>Exactly what the API and MCP take. Edit it here or paste one, then apply and save.</p>
            <textarea className="bb-json" aria-label="Block type definition (JSON)" spellCheck={false} value={jsonText} onChange={e => setJsonText(e.target.value)} />
            {jsonError && <p role="alert" className="bb-status bb-status--error">{jsonError}</p>}
            <div className="bb-actions" style={{ marginTop: '.5rem' }}>
              <button type="button" className="bb-btn" onClick={applyJson}>Apply JSON</button>
              <button type="button" className="bb-btn" onClick={() => void navigator.clipboard?.writeText(jsonText)}>Copy</button>
              <button type="button" className="bb-btn" onClick={() => { setJsonText(JSON.stringify(definition, null, 2)); setJsonError(null); }}>Reset to the current draft</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
