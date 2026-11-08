// The site's Fonts library: upload your own font files (with a licence
// confirmation), see each family in its own font, which roles use it, and
// edit or delete files. Catalog fonts need no upload; they are chosen in the
// site settings.

import { useEffect, useId, useState } from 'react';
import { MAX_FONT_UPLOAD_BYTES, fontSampleText, type SiteFontFile, type SiteFontRole } from '@typeroll/shared';
import {
  ACCEPTED_FONT_FILES, describeInspected, emptyUploadDraft, fontApiError, fontFormatLabel, fontPatch, formatBytes, formatFontWeight,
  groupFontFamilies, prefillFromInspect, rolesLabel, uploadFormData, uploadProblems, weightInput, type FontFamilyGroup, type InspectedFont, type UploadDraft,
} from './font-library-model';
import { previewFontStack } from './font-picker-model';
import { ensureUploadFaces, loadSiteFontLibrary, setSiteFontLibrary, type SiteFontLibrary } from './font-preview';

interface Props {
  siteId: string;
  /** Who may upload, edit and delete: the same people who edit the site settings. */
  canEdit: boolean;
  language?: string;
  /** Server-loaded library; without it the page loads it itself. */
  initial?: SiteFontLibrary | null;
}

type EditDraft = { family: string; weight: string; style: 'normal' | 'italic'; category: '' | 'sans' | 'serif'; licence_note: string };

export default function FontLibrary({ siteId, canEdit, language, initial }: Props) {
  const api = `/api/sites/${encodeURIComponent(siteId)}/fonts`;
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const sample = fontSampleText(language);
  const [library, setLibrary] = useState<SiteFontLibrary | null>(initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UploadDraft>(emptyUploadDraft);
  const [inspected, setInspected] = useState<InspectedFont | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [touched, setTouched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [fileInputKey, setFileInputKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ id: string; draft: EditDraft } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetch(api, { headers: { accept: 'application/json' } })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Partial<SiteFontLibrary> & { error?: string };
        if (cancelled) return;
        if (!response.ok || !Array.isArray(body.fonts)) setLoadError(body.error ?? `Loading failed (${response.status})`);
        else update({ fonts: body.fonts, used_by: body.used_by ?? {} });
      })
      .catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Loading failed'); });
    return () => { cancelled = true; };
  }, [api, initial]);

  useEffect(() => { if (library) ensureUploadFaces(siteId, library.fonts); }, [siteId, library]);

  function update(next: SiteFontLibrary) {
    setLibrary(next);
    setSiteFontLibrary(siteId, next);
  }

  async function refresh() {
    const next = await loadSiteFontLibrary(siteId, { refresh: true });
    update(next);
  }

  async function chooseFile(file: File | null) {
    setUploadError('');
    setInspected(null);
    const next = { ...draft, file };
    setDraft(next);
    if (!file || uploadProblems(next).file) return;
    setInspecting(true);
    try {
      const data = new FormData();
      data.set('file', file);
      const response = await fetch(`${api}/inspect`, { method: 'POST', body: data, headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({})) as { info?: InspectedFont; error?: string; code?: string };
      if (!response.ok || !body.info) { setUploadError(fontApiError(body, response.status, 'Reading the font')); return; }
      setInspected(body.info);
      setDraft(current => current.file === file ? prefillFromInspect(current, body.info!) : current);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Reading the font failed.');
    } finally {
      setInspecting(false);
    }
  }

  const problems = uploadProblems(draft);
  const show = (key: keyof typeof problems) => touched && problems[key];

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    setNotice('');
    if (Object.keys(problems).length) return;
    setUploading(true);
    setUploadError('');
    try {
      const response = await fetch(api, { method: 'POST', body: uploadFormData(draft), headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({})) as { font?: SiteFontFile; error?: string; code?: string };
      if (!response.ok || !body.font) { setUploadError(fontApiError(body, response.status, 'Uploading')); return; }
      update({ fonts: [...(library?.fonts ?? []), body.font], used_by: library?.used_by ?? {} });
      setNotice(`Uploaded ${body.font.family} ${formatFontWeight(body.font)}. Choose it for a role in Settings → Design → Typography.`);
      setDraft(emptyUploadDraft());
      setInspected(null);
      setTouched(false);
      setFileInputKey(key => key + 1);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Uploading failed.');
    } finally {
      setUploading(false);
    }
  }

  async function saveEdit(file: SiteFontFile) {
    if (!editing) return;
    const patch = fontPatch(file, editing.draft);
    if (!patch) { setEditing(null); return; }
    setBusy(file.id);
    setRowError(null);
    try {
      const response = await fetch(`${api}/${encodeURIComponent(file.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify(patch) });
      const body = await response.json().catch(() => ({})) as { font?: SiteFontFile; error?: string; code?: string };
      if (!response.ok || !body.font) { setRowError({ id: file.id, message: fontApiError(body, response.status, 'Saving') }); return; }
      setEditing(null);
      if (patch.family) await refresh();
      else update({ fonts: (library?.fonts ?? []).map(existing => existing.id === file.id ? body.font! : existing), used_by: library?.used_by ?? {} });
    } catch (error) {
      setRowError({ id: file.id, message: error instanceof Error ? error.message : 'Saving failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function remove(file: SiteFontFile) {
    setBusy(file.id);
    setRowError(null);
    setNotice('');
    try {
      const response = await fetch(`${api}/${encodeURIComponent(file.id)}`, { method: 'DELETE', headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({})) as { deleted?: boolean; warning?: string; error?: string; code?: string };
      if (!response.ok || !body.deleted) { setRowError({ id: file.id, message: fontApiError(body, response.status, 'Deleting') }); return; }
      setConfirmDelete(null);
      setNotice(body.warning ? `Deleted. ${body.warning}` : `Deleted ${file.family} ${formatFontWeight(file)}.`);
      update({ fonts: (library?.fonts ?? []).filter(existing => existing.id !== file.id), used_by: library?.used_by ?? {} });
    } catch (error) {
      setRowError({ id: file.id, message: error instanceof Error ? error.message : 'Deleting failed.' });
    } finally {
      setBusy(null);
    }
  }

  const groups = library ? groupFontFamilies(library.fonts, library.used_by) : [];

  return (
    <div className="font-library stack">
      <style dangerouslySetInnerHTML={{ __html: FONT_LIBRARY_CSS }} />
      <div className="app-header"><h1>Fonts</h1></div>
      <p className="muted fl-intro">
        Upload the site’s own font files here: a licensed brand font, or a family that is not in the catalog. Uploaded fonts are always
        served from the website itself. Catalog fonts need no upload: choose them in <a href={`/app/sites/${encodeURIComponent(siteId)}/settings?section=design`}>Settings → Design → Typography</a>,
        where uploaded families also appear.
      </p>

      {notice && <p className="fl-notice" role="status">{notice}</p>}

      {canEdit ? (
        <form className="card stack fl-upload" onSubmit={upload} noValidate aria-labelledby={`${domId}-upload`}>
          <h2 id={`${domId}-upload`}>Upload a font</h2>
          <div className="field">
            <label htmlFor={`${domId}-file`}>Font file</label>
            <input key={fileInputKey} id={`${domId}-file`} type="file" accept={ACCEPTED_FONT_FILES} aria-describedby={`${domId}-file-help${show('file') ? ` ${domId}-file-error` : ''}`}
              aria-invalid={!!show('file') || undefined} onChange={event => void chooseFile(event.target.files?.[0] ?? null)} />
            <p id={`${domId}-file-help`} className="muted text-sm">WOFF2, WOFF, TTF or OTF, at most {formatBytes(MAX_FONT_UPLOAD_BYTES)}. TTF, OTF and WOFF are converted to WOFF2; the original is kept. One variable file can cover all weights.</p>
            {show('file') && <p id={`${domId}-file-error`} className="fl-error">{problems.file}</p>}
            {inspecting && <p className="muted text-sm" role="status">Reading the font…</p>}
            {inspected && <p className="muted text-sm" role="status">Read from the file: {describeInspected(inspected)}</p>}
          </div>
          <div className="fl-grid">
            <div className="field">
              <label htmlFor={`${domId}-family`}>Family name</label>
              <input id={`${domId}-family`} value={draft.family} maxLength={80} placeholder="From the file" aria-invalid={!!show('family') || undefined}
                onChange={event => setDraft({ ...draft, family: event.target.value })} />
              {show('family') && <p className="fl-error">{problems.family}</p>}
            </div>
            <div className="field">
              <label htmlFor={`${domId}-weight`}>Weight</label>
              <input id={`${domId}-weight`} value={draft.weight} inputMode="numeric" aria-describedby={`${domId}-weight-help`} aria-invalid={!!show('weight') || undefined}
                onChange={event => setDraft({ ...draft, weight: event.target.value })} />
              <p id={`${domId}-weight-help`} className="muted text-sm">400 for regular, 700 for bold, or a range such as 100-900 for a variable font.</p>
              {show('weight') && <p className="fl-error">{problems.weight}</p>}
            </div>
            <div className="field">
              <label htmlFor={`${domId}-style`}>Style</label>
              <select id={`${domId}-style`} value={draft.style} onChange={event => setDraft({ ...draft, style: event.target.value as UploadDraft['style'] })}>
                <option value="normal">Upright</option><option value="italic">Italic</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${domId}-category`}>Fallback while loading</label>
              <select id={`${domId}-category`} value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value as UploadDraft['category'] })}>
                <option value="">Automatic</option><option value="sans">Sans serif</option><option value="serif">Serif</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label className="fl-check">
              <input type="checkbox" checked={draft.licence_confirmed} aria-invalid={!!show('licence') || undefined} aria-describedby={show('licence') ? `${domId}-licence-error` : undefined}
                onChange={event => setDraft({ ...draft, licence_confirmed: event.target.checked })} />
              <span>I confirm the font’s licence allows using it on this website</span>
            </label>
            {show('licence') && <p id={`${domId}-licence-error`} className="fl-error">{problems.licence}</p>}
          </div>
          <div className="field">
            <label htmlFor={`${domId}-note`}>Licence note <span className="muted">(optional)</span></label>
            <input id={`${domId}-note`} value={draft.licence_note} maxLength={500} placeholder="e.g. Web licence, order 1234, up to 50,000 views a month"
              onChange={event => setDraft({ ...draft, licence_note: event.target.value })} />
          </div>
          {uploadError && <p className="fl-error" role="alert">{uploadError}</p>}
          <div><button type="submit" className="btn" disabled={uploading || inspecting}>{uploading ? 'Uploading…' : 'Upload font'}</button></div>
        </form>
      ) : (
        <p className="muted">A site admin can upload and change fonts.</p>
      )}

      {loadError ? <p className="fl-error" role="alert">Couldn’t load the fonts: {loadError}</p>
        : !library ? <p className="muted">Loading the fonts…</p>
        : groups.length === 0 ? (
          <div className="card stack fl-empty">
            <h2>No fonts uploaded yet</h2>
            <p>
              Most sites need no upload. The font lists in Settings offer a catalog of 250 open-licence families, the system font and any
              Google Fonts family by name, and publishing copies them to your website.
            </p>
            <p>
              Upload a font when you have a licensed brand font or a family that is not in the catalog. Check that its licence allows web use
              (a desktop licence usually does not). Adobe Fonts are added as a font service in Settings instead, because Adobe’s licence does
              not allow uploading them.
            </p>
          </div>
        ) : groups.map(group => (
          <FamilyCard key={group.family} group={group} siteId={siteId} sample={sample} canEdit={canEdit} editing={editing} setEditing={setEditing}
            confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} rowError={rowError} busy={busy} onSave={saveEdit} onDelete={remove} />
        ))}
    </div>
  );
}

function FamilyCard({ group, siteId, sample, canEdit, editing, setEditing, confirmDelete, setConfirmDelete, rowError, busy, onSave, onDelete }: {
  group: FontFamilyGroup; siteId: string; sample: { heading: string; body: string }; canEdit: boolean;
  editing: { id: string; draft: EditDraft } | null; setEditing: (value: { id: string; draft: EditDraft } | null) => void;
  confirmDelete: string | null; setConfirmDelete: (id: string | null) => void;
  rowError: { id: string; message: string } | null; busy: string | null;
  onSave: (file: SiteFontFile) => void; onDelete: (file: SiteFontFile) => void;
}) {
  const stack = previewFontStack(group.family, group.category);
  const headingId = `family-${group.family.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  return (
    <section className="card stack fl-family" aria-labelledby={headingId}>
      <div className="fl-family__head">
        <h2 id={headingId}>{group.family}</h2>
        <span className="muted text-sm">
          {group.files.length} {group.files.length === 1 ? 'file' : 'files'}
          {group.category ? ` · ${group.category === 'serif' ? 'Serif' : 'Sans serif'}` : ''}
        </span>
      </div>
      <div className="fl-preview" style={{ fontFamily: stack }}>
        <p className="fl-preview__heading">{sample.heading}</p>
        <p className="fl-preview__body">{sample.body}</p>
      </div>
      <p className="text-sm" style={{ margin: 0 }}>
        {group.roles.length
          ? <>Used for: <strong>{rolesLabel(group.roles)}</strong>.</>
          : <>Not used by any role yet. <a href={`/app/sites/${encodeURIComponent(siteId)}/settings?section=design`}>Choose it in Typography</a>.</>}
      </p>
      <div className="fl-table-wrap">
        <table className="fl-table">
          <thead><tr><th scope="col">Weight and style</th><th scope="col">Size</th><th scope="col">Format</th><th scope="col">Licence</th>{canEdit && <th scope="col"><span className="fl-sr">Actions</span></th>}</tr></thead>
          <tbody>
            {group.files.map(file => {
              const [min] = Array.isArray(file.weight) ? file.weight : [file.weight];
              const isEditing = editing?.id === file.id;
              return (
                <tr key={file.id}>
                  <td>
                    <span className="fl-weight" style={{ fontFamily: stack, fontWeight: Array.isArray(file.weight) ? 400 : min, fontStyle: file.style }}>{formatFontWeight(file)}</span>
                    {isEditing && editing && <EditForm file={file} draft={editing.draft} busy={busy === file.id}
                      onChange={draft => setEditing({ id: file.id, draft })} onCancel={() => setEditing(null)} onSave={() => onSave(file)} />}
                    {confirmDelete === file.id && (
                      <div className="fl-confirm" role="alertdialog" aria-label={`Delete ${group.family} ${formatFontWeight(file)}`}>
                        <p>
                          Delete {group.family} {formatFontWeight(file)}?{' '}
                          {group.roles.length ? `${rolesLabel(group.roles)} ${group.roles.length === 1 ? 'uses' : 'use'} this family. ` : ''}
                          The file leaves the site at the next publication; the published site keeps it until then. This cannot be undone.
                        </p>
                        <div className="fl-row">
                          <button type="button" className="btn btn--danger btn--sm" disabled={busy === file.id} onClick={() => onDelete(file)}>{busy === file.id ? 'Deleting…' : 'Delete'}</button>
                          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {rowError?.id === file.id && <p className="fl-error" role="alert">{rowError.message}</p>}
                  </td>
                  <td>{formatBytes(file.file.bytes)}{file.original ? <span className="muted text-sm"> (original {formatBytes(file.original.bytes)})</span> : null}</td>
                  <td>{fontFormatLabel(file)}</td>
                  <td className="text-sm">{file.licence.note ? file.licence.note : <span className="muted">Confirmed</span>}</td>
                  {canEdit && (
                    <td className="fl-actions">
                      <button type="button" className="btn btn--ghost btn--sm" aria-label={`Edit ${group.family} ${formatFontWeight(file)}`} disabled={isEditing}
                        onClick={() => { setConfirmDelete(null); setEditing({ id: file.id, draft: { family: file.family, weight: weightInput(file.weight), style: file.style, category: file.category ?? '', licence_note: file.licence.note ?? '' } }); }}>Edit</button>
                      <button type="button" className="btn btn--ghost btn--sm" aria-label={`Delete ${group.family} ${formatFontWeight(file)}`}
                        onClick={() => { setEditing(null); setConfirmDelete(file.id); }}>Delete</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EditForm({ file, draft, busy, onChange, onCancel, onSave }: {
  file: SiteFontFile; draft: EditDraft; busy: boolean; onChange: (draft: EditDraft) => void; onCancel: () => void; onSave: () => void;
}) {
  const id = `edit-${file.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div className="fl-edit" role="group" aria-label={`Edit ${file.family} ${formatFontWeight(file)}`}>
      <div className="fl-grid">
        <div className="field"><label htmlFor={`${id}-family`}>Family name</label><input id={`${id}-family`} value={draft.family} maxLength={80} onChange={event => onChange({ ...draft, family: event.target.value })} /></div>
        <div className="field"><label htmlFor={`${id}-weight`}>Weight</label><input id={`${id}-weight`} value={draft.weight} onChange={event => onChange({ ...draft, weight: event.target.value })} /></div>
        <div className="field"><label htmlFor={`${id}-style`}>Style</label>
          <select id={`${id}-style`} value={draft.style} onChange={event => onChange({ ...draft, style: event.target.value as EditDraft['style'] })}><option value="normal">Upright</option><option value="italic">Italic</option></select>
        </div>
        <div className="field"><label htmlFor={`${id}-category`}>Fallback while loading</label>
          <select id={`${id}-category`} value={draft.category} onChange={event => onChange({ ...draft, category: event.target.value as EditDraft['category'] })}><option value="">Automatic</option><option value="sans">Sans serif</option><option value="serif">Serif</option></select>
        </div>
      </div>
      <div className="field"><label htmlFor={`${id}-note`}>Licence note</label><input id={`${id}-note`} value={draft.licence_note} maxLength={500} onChange={event => onChange({ ...draft, licence_note: event.target.value })} /></div>
      <p className="muted text-sm" style={{ margin: 0 }}>Renaming the family changes it for this file only; roles that chose the old name keep it until you choose again in Typography.</p>
      <div className="fl-row">
        <button type="button" className="btn btn--sm" disabled={busy} onClick={onSave}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export const FONT_LIBRARY_CSS = `
.font-library { max-width: 960px; min-width: 0; }
.font-library h2 { font-size: 1.125rem; margin: 0; }
.fl-intro { max-width: 760px; margin: 0; }
.fl-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .75rem; }
.fl-check { display: flex !important; align-items: flex-start; gap: .5rem; cursor: pointer; font-weight: 500; }
.fl-check input { width: auto; margin-top: 3px; }
.fl-error { color: var(--color-danger); font-size: .875rem; margin: 0; }
.fl-notice { margin: 0; padding: .6rem .85rem; border-radius: var(--radius-md); border: 1px solid var(--color-success); background: color-mix(in srgb, var(--color-success) 8%, var(--color-surface)); }
.fl-family__head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .25rem 1rem; }
.fl-preview { padding: .75rem 1rem; border-radius: var(--radius-md); background: var(--color-bg); border: 1px solid var(--color-border); overflow-wrap: anywhere; }
.fl-preview p { margin: 0; }
.fl-preview__heading { font-size: 1.75rem; line-height: 1.2; font-weight: 700; }
.fl-preview__body { font-size: 1rem; line-height: 1.5; margin-top: .35rem !important; }
.fl-table-wrap { overflow-x: auto; }
.fl-table { width: 100%; border-collapse: collapse; font-size: .9rem; }
.fl-table th { text-align: left; font-size: .8rem; color: var(--color-text-muted); font-weight: 600; padding: .4rem .5rem; border-bottom: 1px solid var(--color-border); }
.fl-table td { padding: .5rem; border-bottom: 1px solid var(--color-border); vertical-align: top; }
.fl-weight { font-size: 1.05rem; }
.fl-actions { white-space: nowrap; text-align: right; }
.fl-edit, .fl-confirm { display: grid; gap: .6rem; margin-top: .6rem; padding: .75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); min-width: 16rem; }
.fl-confirm p { margin: 0; }
.fl-row { display: flex; flex-wrap: wrap; gap: .5rem; }
.fl-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
