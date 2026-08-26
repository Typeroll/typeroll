// Page → template association picker. Lists every PageTemplate on the
// site and writes the chosen one (or null) to the page's `template`
// field via a PATCH. Mounted in both HtmlPageEditor and BlockPageEditor.
//
// Visibility rule (applies_to):
//   'any' → always shown
//   'page' → shown on standalone pages (we don't currently render
//            collection items through this editor, so 'page' is the
//            common case)
//   'collection:{name}' → hidden here; collection items pick templates
//                         via the collection's item editor

import { useEffect, useState } from 'react';
import type { PageTemplate } from '@typeroll/shared';
import { ExternalLink } from 'lucide-react';

interface Props {
  siteId: string;
  pageId: string;
  currentTemplate?: string;
}

export default function TemplatePicker({ siteId, pageId, currentTemplate }: Props) {
  const [templates, setTemplates] = useState<PageTemplate[]>([]);
  const [selected, setSelected] = useState<string>(currentTemplate ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/sites/${siteId}/templates`)
      .then((r) => r.ok ? r.json() as Promise<{ templates: PageTemplate[] }> : Promise.resolve({ templates: [] }))
      .then((j) => setTemplates(
        (j.templates ?? []).filter((t) => t.status === 'published' &&
          (!t.applies_to || t.applies_to === 'any' || t.applies_to === 'page'))
      ))
      .catch(() => {});
  }, [siteId]);

  useEffect(() => {
    setSelected(currentTemplate ?? '');
  }, [currentTemplate]);

  async function apply(next: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // Use the cookie PATCH route so this works without an API key.
      const res = await fetch(`/api/sites/${siteId}/pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: next || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      setSelected(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

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
      {templates.length === 0 ? (
        <p style={muted}>
          No published templates.{' '}
          <a href={`/app/sites/${siteId}/templates`} style={link}>Create one</a>.
        </p>
      ) : (
        <>
          <select
            value={selected}
            disabled={saving}
            onChange={(e) => void apply(e.target.value)}
            style={selectInput}
          >
            <option value="">No template (render directly)</option>
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
      {error && <p style={errorMsg}>{error}</p>}
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
