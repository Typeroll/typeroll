import { useEffect, useState } from 'react';

interface Option { id: string; title: string }
const inputStyle = { width: '100%', minWidth: 0, maxWidth: '100%', padding: '0.55rem', font: 'inherit' } as const;

/** The editor stores stable Page IDs; people choose titles, across content types. */
export default function ContentReferenceInput({ id, siteId, value, onChange, multiple = false, contentType, types = false }: {
  id: string; siteId: string; value: unknown; onChange: (value: unknown) => void; multiple?: boolean; contentType?: string; types?: boolean;
}) {
  const selected = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : typeof value === 'string' && value ? [value] : [];
  const [search, setSearch] = useState(''), [options, setOptions] = useState<Option[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const selectedKey = selected.join(',');
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const query = new URLSearchParams({ q: search, include_unrouted: 'true', ids: selectedKey });
        if (contentType) query.set('content_type', contentType);
        const url = `/api/sites/${encodeURIComponent(siteId)}/${types ? 'content-types' : `pages?${query}`}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load choices. Try searching again.');
        const data = await response.json();
        setOptions(types ? (data.content_types ?? []).map((type: { id: string; label_plural: string }) => ({ id: type.id, title: type.label_plural })) : data.pages ?? []);
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load choices'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [siteId, types, contentType, search, selectedKey]);
  const choose = (target: string) => {
    if (multiple) onChange(target && !selected.includes(target) ? [...selected, target] : selected);
    else onChange(target);
  };
  const choices = [...selected.filter(id => !options.some(option => option.id === id)).map(id => ({ id, title: id })), ...options];
  return <div style={{ display: 'grid', gap: '0.5rem', minWidth: 0 }}>
    {!types && <input aria-label="Search pages" placeholder="Search pages…" value={search} onChange={event => setSearch(event.target.value)} style={inputStyle} />}
    <select id={id} value={multiple ? '' : selected[0] ?? ''} onChange={event => choose(event.target.value)} style={inputStyle} aria-busy={loading}>
      <option value="">{loading ? 'Loading…' : multiple ? 'Add a page…' : 'None'}</option>
      {choices.filter(option => !multiple || !selected.includes(option.id)).map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
    </select>
    {multiple && <ol style={{ paddingLeft: '1.25rem', margin: 0 }}>{selected.map((pageId, index) => <li key={pageId} style={{ overflowWrap: 'anywhere', marginBottom: '0.4rem' }}>
      {choices.find(option => option.id === pageId)?.title ?? pageId}{' '}
      <button type="button" disabled={index === 0} aria-label="Move page earlier" onClick={() => { const next = [...selected]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>↑</button>{' '}
      <button type="button" aria-label="Remove page reference" onClick={() => onChange(selected.filter(id => id !== pageId))}>Remove</button>
    </li>)}</ol>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
