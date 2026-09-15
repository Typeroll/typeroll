import { useState } from 'react';
import { templateMatchesContentType, type PageTemplate, type ContentType, type FieldDefinition } from '@typeroll/shared';
export default function ContentTypeEditor({ siteId, contentType, templates }: { siteId: string; contentType?: ContentType; templates: PageTemplate[] }) {
  const [type, setType] = useState<Partial<ContentType>>(contentType ?? { fields: [], route_template: '/{slug}' });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const update = (patch: Partial<ContentType>) => { setType(current => ({ ...current, ...patch })); setMessage(''); };
  const compatibleTemplates = templates.filter(template => templateMatchesContentType(template, type.name ?? 'page'));
  const allowedTemplates = compatibleTemplates.filter(template => !Array.isArray(type.allowed_templates) || type.allowed_templates.includes(template.id));
  const editField = (index: number, patch: Partial<FieldDefinition>) => update({ fields: type.fields?.map((field, i) => i === index ? { ...field, ...patch } : field) });
  return <form className="card content-type-editor" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/sites/${siteId}/content-types${contentType ? `/${contentType.id}` : ''}`, {
        method: contentType ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(type),
      });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Could not save content type');
      if (!contentType) window.location.href = `/app/sites/${siteId}/content-types/${result.content_type.id}`;
      else setMessage('Content type saved.');
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <style>{`
      .content-type-editor { display:flex; flex-direction:column; gap:1rem; min-width:0; }
      .content-type-editor h2, .content-type-editor p { margin:0; }
      .content-type-editor > label, .content-type-editor fieldset > label { display:flex; flex-direction:column; gap:.4rem; min-width:0; }
      .content-type-editor label:has(input[type="checkbox"]) { flex-direction:row; align-items:center; gap:.65rem; min-height:44px; }
      .content-type-editor input:not([type="checkbox"]), .content-type-editor select, .content-type-editor textarea { width:100%; box-sizing:border-box; min-width:0; min-height:44px; padding:.6rem .75rem; font:inherit; color:var(--color-text); background:var(--color-surface); border:1px solid var(--color-border); border-radius:.5rem; }
      .content-type-editor input[type="checkbox"] { width:18px; height:18px; flex-shrink:0; }
      .content-type-editor fieldset { display:flex; flex-direction:column; gap:.75rem; min-width:0; padding:1rem; border:1px solid var(--color-border); border-radius:.5rem; }
      .content-type-editor > button { align-self:flex-start; min-height:44px; }
      .content-type-editor [role="status"] { color:var(--color-text); }
    `}</style>
    {!contentType && <label>Content type ID<input required pattern="[a-z][a-z0-9_-]{0,62}" placeholder="article" value={type.name ?? ''} onChange={e => update({ name: e.target.value })} /></label>}
    <label>Singular name<input required placeholder="Article" value={type.label_singular ?? ''} onChange={e => update({ label_singular: e.target.value })} /></label>
    <label>Plural name<input required placeholder="Articles" value={type.label_plural ?? ''} onChange={e => update({ label_plural: e.target.value })} /></label>
    <label>URL pattern<input placeholder="/articles/{slug}" value={type.route_template ?? ''} onChange={e => update({ route_template: e.target.value })} /></label>
    <p className="muted text-sm">Use {'{slug}'} or a custom field such as {'{category}'}. Leave empty if these pages should have no public URL.</p>
    <h2>Sorting</h2>
    <label>Default sort field<select value={type.sort_field ?? 'sort_order'} onChange={e => update({ sort_field: e.target.value })}>
      <option value="sort_order">Manual page order</option><option value="title">Title</option><option value="date_published">Publication date</option><option value="date_updated">Last updated</option>
      {(type.fields ?? []).filter(field => ['text', 'number', 'date', 'datetime', 'select'].includes(field.type) && field.name).map(field => <option key={field.name} value={field.name}>{field.label || field.name}</option>)}
    </select></label>
    <label>Default sort direction<select value={type.sort_dir ?? 'asc'} onChange={e => update({ sort_dir: e.target.value as 'asc' | 'desc' })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    <p className="muted text-sm">Listings and previous/next links use this order. Each listing can override it. Set a page’s order in its metadata; lower numbers come first in ascending lists.</p>
    <h2>Page templates</h2>
    <p className="muted text-sm">Templates control presentation. Several templates can share this content type’s fields.</p>
    <label><input type="checkbox" checked={Array.isArray(type.allowed_templates)} onChange={e => update({ allowed_templates: e.target.checked ? (type.template ? [type.template] : []) : null })} /> Limit the templates editors can choose</label>
    {Array.isArray(type.allowed_templates) && <fieldset><legend>Allowed templates</legend>
      {compatibleTemplates.map(template => <label key={template.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={type.allowed_templates?.includes(template.id) ?? false} onChange={e => update({ allowed_templates: e.target.checked ? [...(type.allowed_templates ?? []), template.id] : type.allowed_templates?.filter(id => id !== template.id), ...(!e.target.checked && type.template === template.id ? { template: '' } : {}) })} />{template.label}{template.status !== 'published' ? ' (draft)' : ''}</label>)}
      {!compatibleTemplates.length && <p>No compatible templates. Create a template first.</p>}
    </fieldset>}
    <label>Default template<select value={type.template ?? ''} onChange={e => update({ template: e.target.value })}><option value="">Page body only</option>{allowedTemplates.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
    <h2>Custom fields</h2><p className="muted text-sm">Every page already has a title, slug, block content, SEO settings and publication status.</p>
    {(type.fields ?? []).map((field, index) => <fieldset key={index} className="stack-sm" style={{ minWidth: 0, padding: 12 }}>
      <label>Label<input required value={field.label} onChange={e => editField(index, { label: e.target.value })} /></label>
      <label>Field ID<input required pattern="[a-z][a-z0-9_]*" value={field.name} onChange={e => editField(index, { name: e.target.value })} /></label>
      <label>Type<select value={field.type} onChange={e => editField(index, { type: e.target.value as FieldDefinition['type'] })}>{['text', 'textarea', 'richtext', 'image', 'file', 'url', 'number', 'boolean', 'date', 'select', 'page_ref', 'page_ref_list'].map(type => <option key={type}>{type}</option>)}</select></label>
      {field.type === 'select' && <label>Choices, one per line<textarea value={(field.options ?? []).join('\n')} onChange={e => editField(index, { options: e.target.value.split('\n') })} /></label>}
      <label><input type="checkbox" checked={!!field.required} onChange={e => editField(index, { required: e.target.checked })} /> Required</label>
      <button type="button" className="btn btn-secondary" onClick={() => update({ fields: type.fields?.filter((_, i) => i !== index) })}>Remove field</button>
    </fieldset>)}
    <button type="button" className="btn btn-secondary" onClick={() => update({ fields: [...(type.fields ?? []), { name: '', label: '', type: 'text' }] })}>Add field</button>
    <label>Schema.org type<input placeholder="Article" value={type.schema_type ?? ''} onChange={e => update({ schema_type: e.target.value })} /></label>
    <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save content type'}</button>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {contentType && contentType.id !== 'page' && <button type="button" className="btn btn-secondary" onClick={async () => {
      if (!window.confirm('Delete this content type? Pages must be moved or deleted first.')) return;
      const response = await fetch(`/api/sites/${siteId}/content-types/${contentType.id}`, { method: 'DELETE' });
      if (response.ok) window.location.href = `/app/sites/${siteId}/content-types`;
      else { const result = await response.json(); setError(result.error ?? 'Could not delete content type'); }
    }}>Delete content type</button>}
  </form>;
}
