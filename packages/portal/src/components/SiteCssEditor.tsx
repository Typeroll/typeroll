import { useState } from 'react';
import type { SiteStyle } from '@typeroll/shared';
import CustomCssEditor from './CustomCssEditor';

/** Site-wide custom CSS on the Styles page, with a preview of the site. */
export default function SiteCssEditor({ siteId, initialCss, styles, canEdit }: { siteId: string; initialCss: string; styles: SiteStyle[]; canEdit: boolean }) {
  const [previewError, setPreviewError] = useState<string | null>(null);
  const hints = styles
    .filter(style => !['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'link'].includes(style.role ?? ''))
    .map(style => ({ className: `s-${style.id}`, label: `Style: ${style.name}` }));

  async function openPreview() {
    setPreviewError(null);
    const res = await fetch(`/api/sites/${siteId}/preview-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json().catch(() => ({})) as { url?: string; error?: string };
    if (!res.ok || !body.url) { setPreviewError(body.error ?? 'Could not open a preview'); return; }
    window.open(body.url, '_blank', 'noopener');
  }

  if (!canEdit) {
    return <section className="site-css" aria-labelledby="site-css-title">
      <h2 id="site-css-title">Site CSS</h2>
      <p className="muted">Only site admins can change site-wide CSS.</p>
      {initialCss && <pre className="site-css__readonly">{initialCss}</pre>}
    </section>;
  }

  return (
    <section className="site-css" aria-labelledby="site-css-title">
      <h2 id="site-css-title">Site CSS</h2>
      <CustomCssEditor
        theme="light"
        label="CSS for every page"
        value={initialCss}
        classHints={hints}
        help={<>Loaded after styles, so it can refine them. Prefer changing a named style; use this for what styles cannot express. Target style classes (<code>.s-…</code>) or a block's CSS class, not platform markup such as <code>[data-block]</code> or <code>.block-…</code>, which can change between render versions. Page CSS, set in the page editor, comes after this.</>}
        onSave={async css => {
          const res = await fetch(`/api/sites/${siteId}/custom-css`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ css }) });
          const body = await res.json().catch(() => ({})) as { warnings?: string[]; error?: string };
          if (!res.ok) throw new Error(body.error ?? `Saving failed (${res.status})`);
          return body.warnings;
        }}
      />
      <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn--secondary" onClick={() => void openPreview()}>Preview site</button>
        <span className="muted" style={{ fontSize: '.85rem' }}>The preview uses saved CSS. The live site changes at the next deploy.</span>
        {previewError && <span role="alert" style={{ color: 'var(--color-danger)' }}>{previewError}</span>}
      </div>
      <style>{`.site-css { display: grid; gap: .75rem; margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid var(--color-border); max-width: 960px; } .site-css h2 { font-size: 1.25rem; } .site-css__readonly { white-space: pre-wrap; font: 12px/1.6 var(--font-mono); background: #fff; border: 1px solid var(--color-border); padding: 10px; border-radius: 6px; }`}</style>
    </section>
  );
}
