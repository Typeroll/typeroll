import { useState } from 'react';
import type { BlockTemplate } from '@typeroll/shared';
import { groupBlockTemplates, importedFromLabel, templateKindLabel } from './block-template-model';
import { collectionApi, collectionPageHref, templateSaveKind } from './collection-model';
import { packageApiError } from './package-import-model';
import { TemplateDesignFindings, type TemplateDesignFindingView } from './TemplateDesignFindings';

interface Props {
  siteId: string;
  initial: BlockTemplate[];
  canEdit: boolean;
  /** Owners, administrators and builders of the owning organization can save a template to its collection. */
  canUseCollection?: boolean;
  /** Hard-coded colours and fonts per template id (lib/design-token-audit.ts). */
  findings?: Record<string, TemplateDesignFindingView[]>;
}

/** The site's block templates: rename, describe, delete or save to the organization collection. Templates are saved from a block in the page editor. */
export default function BlockTemplateList({ siteId, initial, canEdit, canUseCollection = false, findings: initialFindings = {} }: Props) {
  const [templates, setTemplates] = useState(initial);
  const [findings, setFindings] = useState(initialFindings);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function saveToCollection(template: BlockTemplate) {
    setBusy(template.id);
    setMessage(null);
    setSavedTo(null);
    try {
      const res = await fetch(`${collectionApi(siteId)}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: templateSaveKind(template), id: template.id }) });
      const body = await res.json().catch(() => null) as { entry?: { name?: string } } | null;
      if (!res.ok || !body?.entry) { setMessage(packageApiError(body, res.status, 'Saving to the collection').message); return; }
      setSavedTo(body.entry.name ?? template.name);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Saving to the collection failed.');
    } finally { setBusy(null); }
  }

  async function save(id: string) {
    const res = await fetch(`/api/sites/${siteId}/block-templates/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, description }) });
    const body = await res.json().catch(() => ({})) as { block_template?: BlockTemplate; design_findings?: TemplateDesignFindingView[]; error?: string };
    if (!res.ok || !body.block_template) { setMessage(body.error ?? 'Could not save'); return; }
    setTemplates(list => list.map(t => t.id === id ? body.block_template! : t));
    if (body.design_findings) setFindings(all => ({ ...all, [id]: body.design_findings! }));
    setEditing(null);
    setMessage('Saved');
  }

  async function remove(template: BlockTemplate) {
    if (!confirm(`Delete the template "${template.name}"? Pages that already use a copy keep it.`)) return;
    const res = await fetch(`/api/sites/${siteId}/block-templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' });
    if (!res.ok) { setMessage('Could not delete'); return; }
    setTemplates(list => list.filter(t => t.id !== template.id));
    setMessage('Deleted');
  }

  if (!templates.length) {
    return <div className="card gb-empty"><p style={{ maxWidth: 560, margin: '0 auto' }}>
      No templates yet. In the page editor, select a section and choose <strong>Save as template</strong>. Inserting a template
      copies its blocks into the page, so each page can then change its copy. Or import a template pack on the <a href={`/app/sites/${siteId}/packages`}>Packages</a> page.
    </p></div>;
  }
  const groups = groupBlockTemplates(templates);
  const card = (template: BlockTemplate) => editing === template.id ? (
    <div key={template.id} className="card gb-card" style={{ display: 'grid', gap: '.5rem' }}>
      <label>Name<input value={name} onChange={e => setName(e.target.value)} /></label>
      <label>When to use it<input value={description} onChange={e => setDescription(e.target.value)} /></label>
      <div className="row"><button type="button" className="btn" onClick={() => void save(template.id)}>Save</button><button type="button" className="btn btn--secondary" onClick={() => setEditing(null)}>Cancel</button></div>
    </div>
  ) : (
    <div key={template.id} className="card gb-card">
      {template.preview
        ? <img className="gb-card__preview" src={template.preview} alt="" loading="lazy" />
        : <div className="gb-card__icon" aria-hidden="true">⧉</div>}
      <h3 className="gb-card__title">{template.name}{templateKindLabel(template) && <span className="gb-card__kind">{templateKindLabel(template)}</span>}</h3>
      {template.description && <p className="text-sm gb-card__meta">{template.description}</p>}
      <p className="text-sm gb-card__meta">{template.blocks.length} {template.blocks.length === 1 ? 'block' : 'blocks'} · <code className="inline-code">{template.id}</code></p>
      {importedFromLabel(template) && <p className="text-sm muted gb-card__meta" title={template.imported_from?.author ? `By ${template.imported_from.author}` : undefined}>{importedFromLabel(template)}</p>}
      {findings[template.id]?.length ? <details className="text-sm gb-card__meta">
        <summary>{findings[template.id].length === 1 ? '1 hard-coded value' : `${findings[template.id].length} hard-coded values`}</summary>
        <TemplateDesignFindings siteId={siteId} template={template} findings={findings[template.id]} canEdit={canEdit}
          onSaved={(result) => { setTemplates(list => list.map(t => t.id === result.template.id ? result.template : t)); setFindings(all => ({ ...all, [result.template.id]: result.findings })); setMessage(result.findings.length ? 'Saved' : `Saved: “${result.template.name}” now follows the site’s design.`); }} />
      </details> : null}
      {canEdit && <div className="row" style={{ marginTop: '.5rem' }}>
        <button type="button" className="btn btn--secondary" onClick={() => { setEditing(template.id); setName(template.name); setDescription(template.description ?? ''); }}>Rename</button>
        <button type="button" className="btn btn--secondary" onClick={() => void remove(template)}>Delete</button>
        {canUseCollection && <button type="button" className="btn btn--secondary" disabled={busy !== null} onClick={() => void saveToCollection(template)}>{busy === template.id ? 'Saving…' : 'Save to collection'}</button>}
      </div>}
    </div>
  );
  const categorized = groups.some(group => group.category);
  return (
    <div className="stack">
      {message && <p role="status" style={{ margin: 0 }}>{message}</p>}
      {savedTo && <p role="status" style={{ margin: 0 }}>Saved “{savedTo}” to the organization’s <a href={collectionPageHref(siteId)}>collection</a>, with the styles it uses. Insert it into any of the organization’s sites.</p>}
      {groups.map(group => (
        <div key={group.category ?? ''}>
          {categorized && <h3 className="gb-category">{group.category ?? 'Other'}</h3>}
          <div className="gb-grid">{group.templates.map(card)}</div>
        </div>
      ))}
      <style dangerouslySetInnerHTML={{ __html: BLOCK_TEMPLATE_LIST_CSS }} />
    </div>
  );
}

const BLOCK_TEMPLATE_LIST_CSS = `
.gb-card__preview { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--color-bg); }
.gb-card__kind { margin-left: .4rem; padding: 0 .4rem; border: 1px solid var(--color-border); border-radius: 999px; font-size: .7rem; font-weight: 600; color: var(--color-text-muted); vertical-align: middle; }
.gb-category { font-size: .9rem; margin: 0 0 .5rem; }
`;
