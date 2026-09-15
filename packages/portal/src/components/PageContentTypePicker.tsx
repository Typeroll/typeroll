import { useEffect, useState } from 'react';
import type { ContentType, Page } from '@typeroll/shared';
import FieldInput from './FieldInput';

export default function PageContentTypePicker({ siteId, page, disabled = false }: { siteId: string; page: Page; disabled?: boolean }) {
  const [types, setTypes] = useState<ContentType[]>([]);
  const [selected, setSelected] = useState(page.content_type ?? 'page');
  const [nextFields, setNextFields] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/sites/${encodeURIComponent(siteId)}/content-types`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Could not load content types.'); return response.json(); })
      .then(data => setTypes(data.content_types ?? []))
      .catch(error => { if (error.name !== 'AbortError') setError(error.message); });
    return () => controller.abort();
  }, [siteId]);
  const target = types.find(type => type.id === selected);
  const changing = selected !== (page.content_type ?? 'page');
  const removed = target ? Object.keys(page.fields ?? {}).filter(name => !target.fields.some(field => field.name === name)) : [];
  async function apply() {
    if (!target) return;
    setSaving(true); setError('');
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(page.id)}/content-type`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: selected, fields: nextFields }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not change content type.');
      window.location.reload();
    } catch (error) { setError((error as Error).message); setSaving(false); }
  }
  return <div className="field page-type-picker">
    <label htmlFor="page-content-type">Content type</label>
    <select id="page-content-type" value={selected} disabled={disabled || saving || !types.length} onChange={event => {
      const next = types.find(type => type.id === event.target.value);
      setSelected(event.target.value); setError('');
      setNextFields(Object.fromEntries((next?.fields ?? []).flatMap(field => field.name in (page.fields ?? {})
        ? [[field.name, page.fields![field.name]]] : field.default !== undefined ? [[field.name, field.default]] : [])));
    }}>
      {types.map(type => <option key={type.id} value={type.id}>{type.label_singular}</option>)}
    </select>
    {disabled && <p className="muted text-sm">Save or discard your changes before changing content type.</p>}
    {changing && target && <>
      <p className="muted text-sm">The page content and existing address are kept. The new type supplies its fields and default template. {target.route_template === '' && 'This type has no public page address.'}</p>
      {removed.length > 0 && <p role="status">These fields will be removed from the page: {removed.join(', ')}. Their previous values remain in revision history.</p>}
      <fieldset disabled={disabled || saving} className="page-type-picker__fields">
        {target.fields.map(field => <FieldInput key={`${target.id}:${field.name}`} siteId={siteId} field={field} value={nextFields[field.name]} onChange={value => setNextFields(current => ({ ...current, [field.name]: value }))} />)}
      </fieldset>
      <button type="button" className="btn btn-primary" disabled={disabled || saving} onClick={() => void apply()}>{saving ? 'Saving…' : 'Save content type'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
