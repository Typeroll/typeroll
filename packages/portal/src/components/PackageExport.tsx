// Export a Typeroll package (.typeroll) from the site: templates and parts
// (block templates, page templates, global blocks, block types, styles and
// optionally the design and fonts) or the whole site, with the package's
// name, version, author and licence. The logic lives in
// package-export-model.ts.

import { useEffect, useId, useState } from 'react';
import { groupBlockTemplates } from './block-template-model';
import {
  EXPORT_SECTIONS, downloadFilename, exportBody, exportProblems, fontGroups, fontsApply, initialExportDraft, withName,
  type ExportDraft, type ExportField, type ExportSection, type Exportable,
} from './package-export-model';
import { packageApiError, type PackageApiError } from './package-import-model';

interface Props {
  siteId: string;
  /** Write access: needed to export templates and parts. */
  canEdit: boolean;
  /** A site admin may export the whole site. */
  isAdmin: boolean;
  /** The site's language, prefilled as the sample text's language. */
  language?: string;
  /** Server-loaded list; without it the component loads it. */
  initial?: Exportable | null;
}

/** Save a blob under a file name through a temporary link. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function PackageExport({ siteId, canEdit, isAdmin, language, initial }: Props) {
  const api = `/api/sites/${encodeURIComponent(siteId)}/packages`;
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [exportable, setExportable] = useState<Exportable | null>(initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExportDraft>(() => initialExportDraft(initial ?? null, language));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PackageApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (initial || !canEdit) return;
    let cancelled = false;
    fetch(`${api}/exportable`, { headers: { accept: 'application/json' } })
      .then(async response => {
        const body = await response.json().catch(() => null) as Exportable | { error?: string } | null;
        if (cancelled) return;
        if (!response.ok || !body || !('block_templates' in body)) { setLoadError(packageApiError(body, response.status, 'Loading').message); return; }
        setExportable(body);
        setDraft(current => ({ ...current, demoMedia: body.media.filter(media => media.demo).map(media => media.id) }));
      })
      .catch(caught => { if (!cancelled) setLoadError(caught instanceof Error ? caught.message : 'Loading failed'); });
    return () => { cancelled = true; };
  }, [api, initial, canEdit]);

  if (!canEdit) {
    return <section className="card stack pk-card" aria-labelledby={`${domId}-title`}>
      <h2 id={`${domId}-title`}>Export a package</h2>
      <p className="muted" style={{ margin: 0 }}>Exporting a package needs write access to this site.</p>
    </section>;
  }

  const problems = exportProblems(draft, exportable, isAdmin);
  const show = (field: ExportField) => touched && problems[field];
  const set = (patch: Partial<ExportDraft>) => { setDraft(current => ({ ...current, ...patch })); setSaved(null); };
  const setMeta = (patch: Partial<ExportDraft['meta']>) => set({ meta: { ...draft.meta, ...patch } });
  const fonts = fontGroups(exportable?.font_families ?? []);

  function toggle(section: ExportSection, id: string, on: boolean) {
    const list = draft.chosen[section];
    set({ chosen: { ...draft.chosen, [section]: on ? [...list, id] : list.filter(item => item !== id) } });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    setError(null);
    if (Object.keys(problems).length) return;
    setBusy(true);
    try {
      const response = await fetch(`${api}/export`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/vnd.typeroll.package+zip, application/json' }, body: JSON.stringify(exportBody(draft, exportable)) });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(packageApiError(body, response.status, 'The export'));
        return;
      }
      const filename = downloadFilename(response.headers.get('content-disposition'), draft.meta);
      saveBlob(await response.blob(), filename);
      setSaved(filename);
    } catch (caught) {
      setError({ message: caught instanceof Error ? caught.message : 'The export failed.', details: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack pk-card" aria-labelledby={`${domId}-title`}>
      <h2 id={`${domId}-title`}>Export a package</h2>
      <p className="muted pk-intro">
        Save parts of this site as a <code>.typeroll</code> file that anyone can import into their own site. The package carries no
        link to this Organization or Site: its images and fonts travel inside it.
      </p>
      {loadError ? <p className="pk-error" role="alert">Couldn’t load what this site can export: {loadError}</p>
        : !exportable ? <p className="muted" role="status">Loading what this site can export…</p>
        : (
          <form className="stack" onSubmit={submit} noValidate>
            <fieldset className="pk-fieldset">
              <legend>What to export</legend>
              <label className="pk-radio">
                <input type="radio" name={`${domId}-kind`} checked={draft.kind === 'collection'} onChange={() => set({ kind: 'collection' })} />
                <span><strong>Templates and parts</strong><span className="muted text-sm"> Block templates, sections, page templates, global blocks and block types, with the styles they use.</span></span>
              </label>
              <label className={`pk-radio${isAdmin ? '' : ' pk-radio--disabled'}`}>
                <input type="radio" name={`${domId}-kind`} checked={draft.kind === 'site'} disabled={!isAdmin} onChange={() => set({ kind: 'site' })} />
                <span><strong>Whole site</strong><span className="muted text-sm"> Every page, global block, menu, style, site field and the design, to start a new site from.</span>
                  {!isAdmin && <span className="muted text-sm pk-block">Only a site admin can export the whole site.</span>}
                </span>
              </label>
              {show('kind') && <p className="pk-error">{problems.kind}</p>}
            </fieldset>

            {draft.kind === 'collection' && <>
              {EXPORT_SECTIONS.map(({ section, label, empty }) => {
                const items = exportable[section] as Array<{ id: string; name?: string; label?: string; kind?: string; category?: string }>;
                const chosen = draft.chosen[section];
                return (
                  <fieldset key={section} className="pk-fieldset">
                    <legend>{label}</legend>
                    {items.length === 0 ? <p className="muted text-sm" style={{ margin: 0 }}>{empty}</p> : <>
                      <div className="pk-row">
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => set({ chosen: { ...draft.chosen, [section]: items.map(item => item.id) } })}>All</button>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => set({ chosen: { ...draft.chosen, [section]: [] } })}>None</button>
                        <span className="muted text-sm">{chosen.length} of {items.length}</span>
                      </div>
                      {section === 'block_templates'
                        ? groupBlockTemplates(exportable.block_templates).map(group => (
                          <div key={group.category ?? ''} className="pk-group">
                            {group.category && <h4>{group.category}</h4>}
                            <ul className="pk-list">{group.templates.map(item => (
                              <li key={item.id}><label className="pk-check">
                                <input type="checkbox" checked={chosen.includes(item.id)} onChange={event => toggle(section, item.id, event.target.checked)} />
                                <span>{item.name}{item.kind && <span className="pk-badge">{item.kind === 'section' ? 'Section' : 'Block'}</span>}</span>
                              </label></li>
                            ))}</ul>
                          </div>
                        ))
                        : <ul className="pk-list">{items.map(item => (
                          <li key={item.id}><label className="pk-check">
                            <input type="checkbox" checked={chosen.includes(item.id)} onChange={event => toggle(section, item.id, event.target.checked)} />
                            <span>{item.name ?? item.label ?? item.id} <code className="muted">{item.id}</code></span>
                          </label></li>
                        ))}</ul>}
                    </>}
                  </fieldset>
                );
              })}
              <fieldset className="pk-fieldset">
                <legend>Styles and design</legend>
                <label className="pk-radio">
                  <input type="radio" name={`${domId}-styles`} checked={draft.styles === 'used'} onChange={() => set({ styles: 'used' })} />
                  <span><strong>The styles the chosen entries use</strong></span>
                </label>
                <label className="pk-radio">
                  <input type="radio" name={`${domId}-styles`} checked={draft.styles === 'all'} onChange={() => set({ styles: 'all' })} />
                  <span><strong>All the site’s styles</strong> <span className="muted text-sm">({exportable.styles.length})</span></span>
                </label>
                <label className="pk-check">
                  <input type="checkbox" checked={draft.design} onChange={event => set({ design: event.target.checked })} />
                  <span>Include the design tokens <span className="muted text-sm">— colours, typography, element styles and font roles, for an import of the whole look.</span></span>
                </label>
                <label className="pk-check">
                  <input type="checkbox" checked={draft.menus} onChange={event => set({ menus: event.target.checked })} />
                  <span>Include the menus <span className="muted text-sm">— links to this site’s pages are left out.</span></span>
                </label>
                <label className="pk-check">
                  <input type="checkbox" checked={draft.siteFields} onChange={event => set({ siteFields: event.target.checked })} />
                  <span>Include the site field definitions <span className="muted text-sm">— the settings pages, without their values.</span></span>
                </label>
              </fieldset>
              {show('entries') && <p className="pk-error" role="alert">{problems.entries}</p>}
            </>}

            {fontsApply(draft) && (fonts.upload.length > 0 || fonts.catalog.length > 0 || fonts.service.length > 0) && (
              <fieldset className="pk-fieldset">
                <legend>Fonts</legend>
                {fonts.upload.length > 0 && <>
                  <p className="text-sm" style={{ margin: 0 }}>Uploaded fonts: include a file only when its licence lets you pass it on.</p>
                  <ul className="pk-list">{fonts.upload.map(family => (
                    <li key={family}><label className="pk-check">
                      <input type="checkbox" checked={draft.fonts.includes(family)}
                        onChange={event => set({ fonts: event.target.checked ? [...draft.fonts, family] : draft.fonts.filter(item => item !== family), fontsConfirmed: false })} />
                      <span>{family}</span>
                    </label></li>
                  ))}</ul>
                  {draft.fonts.length > 0 && (
                    <label className="pk-check pk-licence">
                      <input type="checkbox" checked={draft.fontsConfirmed} onChange={event => set({ fontsConfirmed: event.target.checked })} aria-describedby={show('fonts') ? `${domId}-fonts-error` : undefined} />
                      <span>The licence allows passing these font files on.</span>
                    </label>
                  )}
                  {show('fonts') && <p id={`${domId}-fonts-error`} className="pk-error">{problems.fonts}</p>}
                </>}
                {fonts.catalog.length > 0 && <p className="text-sm" style={{ margin: 0 }}>Included by name: {fonts.catalog.join(', ')}. The importing site loads them from the font catalog.</p>}
                {fonts.service.length > 0 && <p className="text-sm pk-note" style={{ margin: 0 }}>Not transferable: {fonts.service.join(', ')} come from a font service such as Adobe Fonts. The package names them, and whoever imports it adds their own kit or chooses other fonts.</p>}
              </fieldset>
            )}

            {exportable.media.length > 0 && (
              <fieldset className="pk-fieldset">
                <legend>Demo images</legend>
                <p className="muted text-sm" style={{ margin: 0 }}>Mark the images that are only placeholders. Whoever imports the package sees them listed for replacement before publishing.</p>
                <ul className="pk-media">{exportable.media.map(media => (
                  <li key={media.id}><label className="pk-check">
                    <input type="checkbox" checked={draft.demoMedia.includes(media.id)}
                      onChange={event => set({ demoMedia: event.target.checked ? [...draft.demoMedia, media.id] : draft.demoMedia.filter(id => id !== media.id) })} />
                    <img src={media.url} alt="" loading="lazy" width={40} height={40} />
                    <span className="pk-media__name" title={media.filename}>{media.filename}</span>
                  </label></li>
                ))}</ul>
              </fieldset>
            )}

            <fieldset className="pk-fieldset">
              <legend>About the package</legend>
              <div className="pk-grid">
                <div className="field">
                  <label htmlFor={`${domId}-name`}>Name</label>
                  <input id={`${domId}-name`} value={draft.meta.name} maxLength={120} required onChange={event => set({ meta: withName(draft.meta, event.target.value) })} />
                  {show('name') && <p className="pk-error">{problems.name}</p>}
                </div>
                <div className="field">
                  <label htmlFor={`${domId}-id`}>Id</label>
                  <input id={`${domId}-id`} value={draft.meta.id} maxLength={64} spellCheck={false} onChange={event => setMeta({ id: event.target.value, idEdited: true })} />
                  {show('id') ? <p className="pk-error">{problems.id}</p> : <p className="muted text-sm" style={{ margin: 0 }}>Stays the same in every version.</p>}
                </div>
                <div className="field">
                  <label htmlFor={`${domId}-version`}>Version</label>
                  <input id={`${domId}-version`} value={draft.meta.version} maxLength={32} onChange={event => setMeta({ version: event.target.value })} />
                  {show('version') && <p className="pk-error">{problems.version}</p>}
                </div>
                <div className="field">
                  <label htmlFor={`${domId}-languages`}>Language of the sample text</label>
                  <input id={`${domId}-languages`} value={draft.meta.languages} placeholder="en, sv" onChange={event => setMeta({ languages: event.target.value })} />
                  {show('languages') && <p className="pk-error">{problems.languages}</p>}
                </div>
              </div>
              <div className="field">
                <label htmlFor={`${domId}-description`}>Description <span className="muted">(optional)</span></label>
                <textarea id={`${domId}-description`} rows={2} maxLength={2000} value={draft.meta.description} onChange={event => setMeta({ description: event.target.value })} />
              </div>
              <div className="pk-grid">
                <div className="field">
                  <label htmlFor={`${domId}-author`}>Author <span className="muted">(optional)</span></label>
                  <input id={`${domId}-author`} value={draft.meta.authorName} maxLength={120} onChange={event => setMeta({ authorName: event.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`${domId}-author-url`}>Author’s web address <span className="muted">(optional)</span></label>
                  <input id={`${domId}-author-url`} type="url" value={draft.meta.authorUrl} placeholder="https://" onChange={event => setMeta({ authorUrl: event.target.value })} />
                  {show('authorUrl') && <p className="pk-error">{problems.authorUrl}</p>}
                </div>
                <div className="field">
                  <label htmlFor={`${domId}-licence`}>Licence <span className="muted">(optional)</span></label>
                  <input id={`${domId}-licence`} value={draft.meta.licenceName} maxLength={120} placeholder="For example CC BY 4.0" onChange={event => setMeta({ licenceName: event.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`${domId}-licence-url`}>Licence web address <span className="muted">(optional)</span></label>
                  <input id={`${domId}-licence-url`} type="url" value={draft.meta.licenceUrl} placeholder="https://" onChange={event => setMeta({ licenceUrl: event.target.value })} />
                  {show('licenceUrl') && <p className="pk-error">{problems.licenceUrl}</p>}
                </div>
              </div>
            </fieldset>

            {error && (
              <div className="pk-error" role="alert">
                <p style={{ margin: 0 }}><strong>{error.message}</strong></p>
                {error.details.length > 0 && <ul>{error.details.slice(0, 50).map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
              </div>
            )}
            {saved && <p className="pk-notice" role="status">Saved {saved}.</p>}
            <div className="pk-row">
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Building the package…' : 'Export package'}</button>
              {busy && <span className="muted text-sm" role="status">Packing images and fonts can take a while.</span>}
            </div>
          </form>
        )}
    </section>
  );
}
