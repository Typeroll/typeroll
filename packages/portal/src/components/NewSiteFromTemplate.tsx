// "Start from a template or another site" on the new-site page: choose
// another site of the organization, a whole-site package from the
// collection or a .typeroll file; see who made it, its licence and
// signature (an invalid one cannot be used), confirm the font licence when
// it carries font files, then create the site and open its overview, whose
// readiness lists the demo images to replace. The logic lives in
// new-site-template-model.ts.

import { useEffect, useId, useRef, useState } from 'react';
import type { PackageDesignMode } from '@typeroll/shared';
import {
  NEW_SITE_DESIGN_MODES, START_KINDS, choiceReady, createBlockers, createRequest, createdNotes, packageApiError, previewRequest,
  startContents, startOptions, startPublisher, startSignature,
  type CreatedSite, type PackageApiError, type SourcePackage, type SourceSite, type StartChoice, type StartKind, type StartPreview,
} from './new-site-template-model';
import { ACCEPTED_PACKAGE_FILES, formatBytes } from './package-import-model';

interface Props {
  sites: SourceSite[];
  /** Whole-site packages of the collection; absent when the person may not use the collection. */
  packages?: SourcePackage[];
  /** Tests: open the page without navigating. */
  navigate?: (url: string) => void;
}

type Phase = 'idle' | 'previewing' | 'ready' | 'creating' | 'done';

export default function NewSiteFromTemplate({ sites, packages, navigate }: Props) {
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const kinds = START_KINDS.filter(kind => kind.value !== 'collection_entry' || packages !== undefined);
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<StartChoice>({ kind: sites.length ? 'site' : packages?.length ? 'collection_entry' : 'package' });
  const [design, setDesign] = useState<PackageDesignMode>('full');
  const [fontLicence, setFontLicence] = useState(false);
  const [preview, setPreview] = useState<StartPreview | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<PackageApiError | null>(null);
  const [created, setCreated] = useState<{ site: CreatedSite; notes: string[] } | null>(null);
  const request = useRef(0);

  const needsFontLicence = !!preview?.needs.font_licence;
  const options = startOptions({ design, needsFontLicence, fontLicenceConfirmed: fontLicence });
  // The preview only depends on the source and the look (fonts travel with the whole look).
  const previewKey = JSON.stringify([choice.kind, choice.siteId, choice.entryId, choice.file?.name, choice.file?.size, design]);

  useEffect(() => {
    if (!choiceReady(choice)) { setPreview(null); setPhase('idle'); return; }
    const id = ++request.current;
    setPhase('previewing');
    setError(null);
    const { url, init } = previewRequest(choice, { design });
    fetch(url, init).then(async response => {
      const body = await response.json().catch(() => null) as StartPreview | null;
      if (id !== request.current) return;
      if (!response.ok || !body?.source) { setPreview(null); setError(packageApiError(body, response.status, 'Reading the source')); setPhase('idle'); return; }
      setPreview(body);
      setPhase('ready');
    }).catch(() => {
      if (id !== request.current) return;
      setPreview(null);
      setError({ message: 'The source could not be read. Check your connection and try again.', details: [] });
      setPhase('idle');
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const blockers = createBlockers({ name, choice, preview });
  const busy = phase === 'creating' || phase === 'previewing';

  async function create() {
    setPhase('creating');
    setError(null);
    try {
      const { url, init } = createRequest(choice, name, options);
      const response = await fetch(url, init);
      const body = await response.json().catch(() => null) as CreatedSite | null;
      if (!response.ok || !body?.id) { setError(packageApiError(body, response.status, 'Creating the site')); setPhase('ready'); return; }
      const notes = createdNotes(body, preview);
      if (!(body.started_from?.warnings.length)) { (navigate ?? ((target: string) => window.location.assign(target)))(body.url); }
      setCreated({ site: body, notes });
      setPhase('done');
    } catch {
      setError({ message: 'The site could not be created. Check your connection and try again.', details: [] });
      setPhase('ready');
    }
  }

  function choose(kind: StartKind) {
    setChoice({ kind });
    setFontLicence(false);
  }

  if (phase === 'done' && created) {
    return (
      <section className="card stack ns-card" aria-labelledby={`${domId}-title`}>
        <h2 id={`${domId}-title`}>Your new site is ready</h2>
        {created.notes.length > 0 && (
          <div className="ns-warnings" role="note" aria-label="Before you publish">
            <strong>Before you publish</strong>
            <ul>{created.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
          </div>
        )}
        <div><a className="btn" href={created.site.url}>Open the new site</a></div>
      </section>
    );
  }

  const signature = preview ? startSignature(preview) : null;
  return (
    <section className="card stack ns-card" aria-labelledby={`${domId}-title`}>
      <h2 id={`${domId}-title`}>Start from a template or another site</h2>
      <p className="muted text-sm" style={{ margin: 0 }}>
        Pages, header and footer, menus, styles, site fields and media are copied into the new site. Domains, publishing, API keys and apps are not.
      </p>
      <div className="field">
        <label htmlFor={`${domId}-name`}>Site name</label>
        <input id={`${domId}-name`} value={name} required placeholder="My new site" onChange={event => setName(event.target.value)} />
      </div>

      <fieldset className="ns-fieldset">
        <legend>Start from</legend>
        {kinds.map(kind => (
          <label key={kind.value} className="ns-radio">
            <input type="radio" name={`${domId}-kind`} value={kind.value} checked={choice.kind === kind.value} disabled={phase === 'creating'} onChange={() => choose(kind.value)} />
            <span><strong>{kind.label}</strong> <span className="muted text-sm">{kind.help}</span></span>
          </label>
        ))}
      </fieldset>

      {choice.kind === 'site' && (sites.length ? (
        <div className="field">
          <label htmlFor={`${domId}-site`}>Site to copy</label>
          <select id={`${domId}-site`} value={choice.siteId ?? ''} disabled={phase === 'creating'} onChange={event => setChoice({ kind: 'site', siteId: event.target.value || undefined })}>
            <option value="">Choose a site…</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.name} ({site.id})</option>)}
          </select>
        </div>
      ) : <p className="muted text-sm" style={{ margin: 0 }}>Your organization has no other sites yet.</p>)}

      {choice.kind === 'collection_entry' && (packages?.length ? (
        <div className="field">
          <label htmlFor={`${domId}-entry`}>Site package</label>
          <select id={`${domId}-entry`} value={choice.entryId ?? ''} disabled={phase === 'creating'} onChange={event => setChoice({ kind: 'collection_entry', entryId: event.target.value || undefined })}>
            <option value="">Choose a site package…</option>
            {packages.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.name}{entry.publisher ? ` — ${entry.publisher}${entry.verified ? ' (verified)' : ''}` : ''}{entry.pages !== undefined ? ` · ${entry.pages} page${entry.pages === 1 ? '' : 's'}` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : <p className="muted text-sm" style={{ margin: 0 }}>The collection has no whole-site packages yet. Add a <code>.typeroll</code> site package to it from Collection, or choose the file here.</p>)}

      {choice.kind === 'package' && (
        <div className="ns-drop">
          <label htmlFor={`${domId}-file`} className="btn btn--secondary">{choice.file ? 'Choose another file' : 'Choose a .typeroll file'}</label>
          <input id={`${domId}-file`} type="file" accept={ACCEPTED_PACKAGE_FILES} className="ns-sr" disabled={phase === 'creating'}
            onChange={event => setChoice({ kind: 'package', file: event.target.files?.[0] ?? null })} />
          <span className="muted text-sm">{choice.file ? `${choice.file.name} · ${formatBytes(choice.file.size)}` : 'A whole-site package.'}</span>
        </div>
      )}

      {phase === 'previewing' && <div className="ns-progress" role="status"><progress aria-label="Checking the source" /><span className="text-sm">Checking the source…</span></div>}

      {preview && (
        <div className={`stack ns-preview${phase === 'previewing' ? ' ns-stale' : ''}`}>
          {signature && (
            <div className={`ns-signature ns-signature--${signature.tone}`} role={signature.blocks ? 'alert' : 'note'} aria-label="Signature">
              <strong>{signature.label}</strong> <span>{signature.blocks ? 'The signature does not match the file: it was changed after it was signed. A site cannot start from it.' : signature.text}</span>
            </div>
          )}
          <dl className="ns-facts">
            <dt>{preview.package ? 'Package' : 'Site'}</dt>
            <dd>{preview.package ? <>{preview.package.name} <span className="muted">{preview.package.version}</span></> : preview.source.name}</dd>
            {preview.package && <><dt>Publisher</dt><dd>{startPublisher(preview)}</dd></>}
            {preview.package && <><dt>Licence</dt><dd>{preview.package.licence ? (preview.package.licence.url ? <a href={preview.package.licence.url} target="_blank" rel="noopener noreferrer nofollow">{preview.package.licence.name}</a> : preview.package.licence.name) : <span className="muted">Not stated: ask the publisher what you may do with it.</span>}</dd></>}
            {preview.language && <><dt>Language</dt><dd>{preview.language}</dd></>}
            <dt>Contains</dt>
            <dd>{startContents(preview)}{preview.counts.demo_media > 0 && <span className="muted"> · {preview.counts.demo_media} demo image{preview.counts.demo_media === 1 ? '' : 's'} to replace</span>}</dd>
          </dl>
          {preview.warnings.length > 0 && (
            <div className="ns-warnings" role="note" aria-label="Not copied">
              <strong>Good to know</strong>
              <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      <fieldset className="ns-fieldset">
        <legend>How much of its look to take</legend>
        {NEW_SITE_DESIGN_MODES.map(mode => (
          <label key={mode.value} className="ns-radio">
            <input type="radio" name={`${domId}-design`} value={mode.value} checked={design === mode.value} disabled={phase === 'creating'} onChange={() => setDesign(mode.value)} />
            <span><strong>{mode.label}</strong> <span className="muted text-sm">{mode.help}</span></span>
          </label>
        ))}
      </fieldset>

      {needsFontLicence && design === 'full' && (
        <label className="ns-check">
          <input type="checkbox" checked={fontLicence} onChange={event => setFontLicence(event.target.checked)} />
          <span>The licence of its font files ({preview!.needs.fonts.join(', ')}) lets me use them on the new site. <span className="muted text-sm">Without this, the site starts without the font files.</span></span>
        </label>
      )}

      {error && (
        <div className="ns-error" role="alert">
          <p style={{ margin: 0 }}><strong>{error.message}</strong></p>
          {error.details.length > 0 && <ul>{error.details.slice(0, 20).map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
        </div>
      )}
      {blockers.length > 0 && phase !== 'previewing' && <ul className="ns-blockers muted text-sm">{blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <div>
        <button type="button" className="btn" disabled={busy || blockers.length > 0} onClick={() => void create()}>
          {phase === 'creating' ? 'Creating the site…' : 'Create site from this'}
        </button>
      </div>
      {phase === 'creating' && <p className="muted text-sm" role="status" style={{ margin: 0 }}>Copying pages and media. A site with many images takes a while; keep this page open.</p>}
    </section>
  );
}
