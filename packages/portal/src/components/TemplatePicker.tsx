// Page templates apply to every Page; content-type restrictions filter choices.

import { useEffect, useState } from 'react';
import { contentTypeAllowsTemplate, type ContentType, type PageTemplate } from '@typeroll/shared';
import { ExternalLink } from 'lucide-react';

interface Props {
  siteId: string;
  pageId: string;
  currentTemplate?: string;
  contentType?: string;
  defaultTemplate?: string;
  onChange: (template: string) => void;
}

export default function TemplatePicker({ siteId, currentTemplate, contentType = 'page', defaultTemplate, onChange }: Props) {
  const [templates, setTemplates] = useState<PageTemplate[]>([]);
  const [selected, setSelected] = useState<string>(currentTemplate ?? '');
  const [type, setType] = useState<ContentType | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    Promise.all([fetch(`/api/sites/${siteId}/templates`, { signal: controller.signal }), fetch(`/api/sites/${siteId}/content-types`, { signal: controller.signal })])
      .then(async ([templates, types]) => {
        if (!templates.ok || !types.ok) throw new Error('Could not load template choices. Reload and try again.');
        return Promise.all([templates.json(), types.json()]);
      })
      .then(([data, definitions]) => {
        const definition = (definitions.content_types as ContentType[]).find(type => type.id === contentType);
        setType(definition);
        setTemplates((data.templates as PageTemplate[]).filter(template => template.status === 'published' && definition && contentTypeAllowsTemplate(definition, template)));
        setLoading(false);
      }).catch(error => { if (error.name !== 'AbortError') { setError(error.message); setLoading(false); } });
    return () => controller.abort();
  }, [siteId, contentType]);
  useEffect(() => { setSelected(currentTemplate ?? ''); }, [currentTemplate]);

  return (
    <div style={shell}>
      <div style={header}>
        <strong style={headerLabel}>Template</strong>
        <a
          href={`/app/sites/${siteId}/templates`}
          target="_blank"
          rel="noopener"
          style={extLink}
          title="Open the template list"
        >
          <ExternalLink size={11} />
        </a>
      </div>
      {loading ? <p style={muted}>Loading templates…</p> : error ? <p role="alert" style={errorMsg}>{error}</p> : (
        <>
          <select
            aria-label="Page template"
            value={selected}
            disabled={loading}
            onChange={(e) => { setSelected(e.target.value); onChange(e.target.value); }}
            style={selectInput}
          >
            <option value="">{(type?.template || defaultTemplate) ? "Use content type’s default template" : "No default template"}</option>
            {selected && !templates.some(template => template.id === selected) && <option value={selected} disabled>Current template unavailable — choose another</option>}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          {selected && (
            <p style={muted}>
              The page's blocks render where the template's <code>template_content_slot</code> sits.
            </p>
          )}
        </>
      )}
      <p style={muted}>Save the page to apply this choice. Choosing the default follows future changes to the content type’s template.</p>
    </div>
  );
}

const shell: React.CSSProperties = {
  padding: '0.75rem',
  border: '1px solid var(--color-border, #2a2a30)',
  borderRadius: 8,
  marginTop: '0.5rem',
};
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6,
};
const headerLabel: React.CSSProperties = { fontSize: '.85rem' };
const extLink: React.CSSProperties = {
  color: '#a1a1aa', textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
};
const selectInput: React.CSSProperties = {
  width: '100%', padding: '.4rem .6rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, fontSize: '.85rem',
};
const muted: React.CSSProperties = {
  color: '#a1a1aa', fontSize: '.8rem', margin: '.5rem 0 0',
};
const link: React.CSSProperties = { color: '#a5b4fc' };
const errorMsg: React.CSSProperties = { marginTop: 8, color: '#ef4444', fontSize: '.85rem' };
