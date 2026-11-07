// Import a Typeroll package (.typeroll) into the site: choose or drop the
// file, see who made it, its signature and licence, what it would create,
// reuse or rename, pick how much of its look to take, then import. The
// logic lives in package-import-model.ts.

import { useId, useRef, useState } from 'react';
import type { PackageDesignMode } from '@typeroll/shared';
import {
  ACCEPTED_PACKAGE_FILES, DESIGN_MODES, KIND_LABELS, WHOLE_LOOK_ADMIN_NOTE,
  choosableEntries, countLines, designLines, fontLine, formatBytes, importBlockers, importOptions, onlyFromSelection,
  packageApiError, packageFileProblem, packageFormData, planGroups, publisherLine, reportCounts, reportSections, signatureNotice,
  type ChoosableEntry, type ImportReport, type InspectResult, type PackageApiError,
} from './package-import-model';

interface Props {
  siteId: string;
  /** Write access: importing changes the site. */
  canEdit: boolean;
  /** A site admin may import the whole look. */
  isAdmin: boolean;
  /** Tests start from an inspected package. */
  initial?: { file: File; result: InspectResult };
}

type Phase = 'idle' | 'inspecting' | 'ready' | 'importing' | 'done';

export default function PackageImport({ siteId, canEdit, isAdmin, initial }: Props) {
  const api = `/api/sites/${encodeURIComponent(siteId)}/packages`;
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [file, setFile] = useState<File | null>(initial?.file ?? null);
  const [phase, setPhase] = useState<Phase>(initial ? 'ready' : 'idle');
  const [result, setResult] = useState<InspectResult | null>(initial?.result ?? null);
  const [entries, setEntries] = useState<ChoosableEntry[]>(() => initial ? choosableEntries(initial.result.plan) : []);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initial ? choosableEntries(initial.result.plan).map(entry => entry.key) : []));
  const [planOnly, setPlanOnly] = useState<string[] | undefined>(undefined);
  const [design, setDesign] = useState<PackageDesignMode>('content');
  const [includeFonts, setIncludeFonts] = useState(true);
  const [fontLicence, setFontLicence] = useState(false);
  const [error, setError] = useState<PackageApiError | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showEntries, setShowEntries] = useState(false);

  if (!canEdit) {
    return <section className="card stack pk-card" aria-labelledby={`${domId}-title`}>
      <h2 id={`${domId}-title`}>Import a package</h2>
      <p className="muted" style={{ margin: 0 }}>Importing a package needs write access to this site.</p>
    </section>;
  }

  const only = onlyFromSelection(entries, chosen);
  const selectionChanged = JSON.stringify(only ?? null) !== JSON.stringify(planOnly ?? null);

  async function inspect(next: { file: File; design: PackageDesignMode; includeFonts: boolean; only?: string[]; fresh?: boolean }) {
    const id = ++request.current;
    setPhase('inspecting');
    setError(null);
    try {
      const response = await fetch(`${api}/inspect`, { method: 'POST', body: packageFormData(next.file, importOptions(next)) });
      const body = await response.json().catch(() => null) as InspectResult | null;
      if (id !== request.current) return;
      if (!response.ok || !body?.package || !body.plan) {
        setError(packageApiError(body, response.status, 'Reading the package'));
        setPhase(next.fresh ? 'idle' : 'ready');
        if (next.fresh) setResult(null);
        return;
      }
      setResult(body);
      setPlanOnly(next.only);
      if (next.fresh || !next.only) {
        // The full list of entries comes from a plan made without `only`.
        const all = choosableEntries(body.plan);
        setEntries(all);
        if (next.fresh) setChosen(new Set(all.map(entry => entry.key)));
      }
      setPhase('ready');
    } catch (caught) {
      if (id !== request.current) return;
      setError({ message: caught instanceof Error ? caught.message : 'Reading the package failed.', details: [] });
      setPhase(next.fresh ? 'idle' : 'ready');
    }
  }

  function choose(next: File | null) {
    setReport(null);
    setError(null);
    setFontLicence(false);
    setShowEntries(false);
    const problem = packageFileProblem(next);
    if (problem || !next) { setFile(null); setResult(null); setPhase('idle'); setError({ message: problem ?? 'Choose a .typeroll file.', details: [] }); return; }
    setFile(next);
    setResult(null);
    setDesign('content');
    void inspect({ file: next, design: 'content', includeFonts, fresh: true });
  }

  function changeMode(mode: PackageDesignMode) {
    if (!file || mode === design) return;
    setDesign(mode);
    setFontLicence(false);
    void inspect({ file, design: mode, includeFonts, only: planOnly });
  }

  function changeFonts(value: boolean) {
    if (!file) return;
    setIncludeFonts(value);
    setFontLicence(false);
    void inspect({ file, design, includeFonts: value, only: planOnly });
  }

  function toggleEntry(key: string, on: boolean) {
    setChosen(current => {
      const next = new Set(current);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function runImport() {
    if (!file || !result) return;
    setPhase('importing');
    setError(null);
    try {
      const options = importOptions({ design, includeFonts, only, fontLicenceConfirmed: result.needs.font_licence && fontLicence });
      const response = await fetch(`${api}/import`, { method: 'POST', body: packageFormData(file, options) });
      const body = await response.json().catch(() => null) as { report?: ImportReport } | null;
      if (!response.ok || !body?.report) { setError(packageApiError(body, response.status, 'The import')); setPhase('ready'); return; }
      setReport(body.report);
      setPhase('done');
    } catch (caught) {
      setError({ message: caught instanceof Error ? caught.message : 'The import failed.', details: [] });
      setPhase('ready');
    }
  }

  function reset() {
    request.current++;
    setFile(null); setResult(null); setReport(null); setError(null); setPhase('idle'); setEntries([]); setChosen(new Set()); setPlanOnly(undefined);
    if (inputRef.current) inputRef.current.value = '';
  }

  const busy = phase === 'inspecting' || phase === 'importing';
  const blockers = result ? importBlockers({ result, isAdmin, fontLicenceConfirmed: fontLicence, only }) : [];

  return (
    <section className="card stack pk-card" aria-labelledby={`${domId}-title`}>
      <h2 id={`${domId}-title`}>Import a package</h2>
      <p className="muted pk-intro">
        Add block templates, sections, page templates, global blocks and styles from a <code>.typeroll</code> file, for example a
        template pack you bought. Styles are never swapped for similar ones: the styles the content uses come with it, so it looks
        the way it was made.
      </p>

      {phase !== 'done' && (
        <div
          className={`pk-drop${dragOver ? ' pk-drop--over' : ''}`}
          onDragOver={event => { event.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={event => { event.preventDefault(); setDragOver(false); const dropped = event.dataTransfer.files?.[0]; if (dropped && !busy) choose(dropped); }}
        >
          <label htmlFor={`${domId}-file`} className="btn btn--secondary">{file ? 'Choose another file' : 'Choose a .typeroll file'}</label>
          <input ref={inputRef} id={`${domId}-file`} type="file" accept={ACCEPTED_PACKAGE_FILES} className="pk-sr" disabled={busy}
            onChange={event => choose(event.target.files?.[0] ?? null)} />
          <span className="muted text-sm">{file ? `${file.name} · ${formatBytes(file.size)}` : 'or drop it here.'}</span>
        </div>
      )}

      {phase === 'inspecting' && (
        <div className="pk-progress" role="status">
          <progress aria-label="Reading the package" />
          <span className="text-sm">{result ? 'Updating the plan…' : `Uploading and checking ${file?.name ?? 'the package'}${file ? ` (${formatBytes(file.size)})` : ''}…`}</span>
        </div>
      )}
      {phase === 'importing' && (
        <div className="pk-progress" role="status">
          <progress aria-label="Importing" />
          <span className="text-sm">Importing {result?.package.name}. Large packages with many images take a while; keep this page open.</span>
        </div>
      )}

      {error && (
        <div className="pk-error" role="alert">
          <p style={{ margin: 0 }}><strong>{error.message}</strong></p>
          {error.details.length > 0 && <ul>{error.details.slice(0, 50).map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
          {error.details.length > 50 && <p className="text-sm" style={{ margin: 0 }}>…and {error.details.length - 50} more.</p>}
        </div>
      )}

      {result && phase !== 'done' && (
        <div className={`stack pk-inspected${phase === 'inspecting' ? ' pk-stale' : ''}`}>
          <PackageSummary result={result} />

          {result.warnings.length > 0 && (
            <div className="pk-warnings" role="note" aria-label="Warnings">
              <strong>Before you import</strong>
              <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </div>
          )}

          <fieldset className="pk-fieldset">
            <legend>How much of its look to take</legend>
            {DESIGN_MODES.map(mode => {
              const disabled = busy || (mode.adminOnly && !isAdmin);
              return (
                <label key={mode.value} className={`pk-radio${disabled ? ' pk-radio--disabled' : ''}`}>
                  <input type="radio" name={`${domId}-design`} value={mode.value} checked={design === mode.value} disabled={disabled}
                    onChange={() => changeMode(mode.value)} />
                  <span><strong>{mode.label}</strong><span className="muted text-sm"> {mode.help}</span>
                    {mode.adminOnly && !isAdmin && <span className="muted text-sm pk-block">{WHOLE_LOOK_ADMIN_NOTE}</span>}
                  </span>
                </label>
              );
            })}
            {design === 'full' && (
              <label className="pk-check">
                <input type="checkbox" checked={includeFonts} disabled={busy} onChange={event => changeFonts(event.target.checked)} />
                <span>Include fonts <span className="muted text-sm">— the font roles and the font files the package carries.</span></span>
              </label>
            )}
          </fieldset>

          <PlanView result={result} />

          {entries.length > 1 && (
            <div className="stack pk-entries">
              <button type="button" className="btn btn--ghost btn--sm pk-toggle" aria-expanded={showEntries} onClick={() => setShowEntries(open => !open)}>
                {showEntries ? 'Hide the entry list' : 'Choose entries'} <span className="muted">({only ? `${only.length} of ${entries.length}` : `all ${entries.length}`})</span>
              </button>
              {showEntries && <>
                <p className="muted text-sm" style={{ margin: 0 }}>Leave out what you don’t need. The styles and block types the chosen entries use come with them.</p>
                <div className="pk-row">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setChosen(new Set(entries.map(entry => entry.key)))}>Choose all</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setChosen(new Set())}>Choose none</button>
                </div>
                <ul className="pk-list">
                  {entries.map(entry => (
                    <li key={entry.key}>
                      <label className="pk-check">
                        <input type="checkbox" checked={chosen.has(entry.key)} onChange={event => toggleEntry(entry.key, event.target.checked)} />
                        <span>{entry.name} <span className="muted text-sm">{entry.section.replace(/_/g, ' ').replace('site field groups', 'site fields')}</span></span>
                      </label>
                    </li>
                  ))}
                </ul>
                {selectionChanged && file && (
                  <div><button type="button" className="btn btn--secondary btn--sm" disabled={busy || (only?.length === 0)}
                    onClick={() => void inspect({ file, design, includeFonts, only })}>Update the plan for this choice</button></div>
                )}
              </>}
            </div>
          )}

          {result.needs.font_licence && (
            <label className="pk-check pk-licence">
              <input type="checkbox" checked={fontLicence} onChange={event => setFontLicence(event.target.checked)} />
              <span>The package’s licence lets me use its font files on this site. <span className="muted text-sm">The author confirmed they may be passed on; check the terms you got them under.</span></span>
            </label>
          )}

          {blockers.length > 0 && <ul className="pk-blockers">{blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <div className="pk-row">
            <button type="button" className="btn" disabled={busy || blockers.length > 0 || selectionChanged} onClick={() => void runImport()}>
              {phase === 'importing' ? 'Importing…' : `Import ${result.package.name}`}
            </button>
            <button type="button" className="btn btn--ghost" disabled={phase === 'importing'} onClick={reset}>Cancel</button>
            {selectionChanged && <span className="muted text-sm">Update the plan to import this choice.</span>}
          </div>
        </div>
      )}

      {phase === 'done' && report && result && <ImportReportView siteId={siteId} report={report} result={result} onAnother={reset} />}
    </section>
  );
}

export function PackageSummary({ result }: { result: InspectResult }) {
  const pkg = result.package;
  const signature = signatureNotice(result.signature, pkg.author);
  const counts = countLines(pkg.counts);
  return (
    <div className="stack pk-summary">
      <div className="pk-summary__head">
        <h3>{pkg.name} <span className="muted pk-version">{pkg.version}</span></h3>
        <span className="pk-badge">{KIND_LABELS[pkg.kind] ?? pkg.kind}</span>
      </div>
      {pkg.description && <p style={{ margin: 0 }}>{pkg.description}</p>}
      <div className={`pk-signature pk-signature--${signature.tone}`} role={signature.blocks ? 'alert' : 'note'} aria-label="Signature">
        <strong>{signature.label}</strong> <span>{signature.text}</span>
      </div>
      <dl className="pk-facts">
        <dt>Publisher</dt>
        <dd>{publisherLine(result)}{pkg.author?.url && <> · <a href={pkg.author.url} target="_blank" rel="noopener noreferrer nofollow">{pkg.author.url}</a></>}</dd>
        <dt>Licence</dt>
        <dd>{pkg.licence ? (pkg.licence.url ? <a href={pkg.licence.url} target="_blank" rel="noopener noreferrer nofollow">{pkg.licence.name}</a> : pkg.licence.name) : <span className="muted">Not stated: ask the publisher what you may do with it.</span>}</dd>
        {pkg.languages && pkg.languages.length > 0 && <><dt>Sample text</dt><dd>{pkg.languages.join(', ')}</dd></>}
        <dt>Contains</dt>
        <dd>{counts.length ? counts.join(', ') : 'Nothing'}</dd>
      </dl>
    </div>
  );
}

export function PlanView({ result }: { result: InspectResult }) {
  const groups = planGroups(result.plan);
  const design = designLines(result.plan.design);
  const fonts = result.plan.fonts ?? [];
  const media = result.plan.media ?? [];
  return (
    <div className="stack pk-plan">
      <h3>What the import does</h3>
      {groups.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing to import with this choice.</p>}
      {groups.map(group => (
        <div key={group.section} className="pk-plan__group">
          <h4>{group.label} <span className="muted">({group.rows.length})</span></h4>
          <ul className="pk-plan__rows">
            {group.rows.map(row => (
              <li key={row.key} className={`pk-plan__row pk-plan__row--${row.action}`}>
                <span className="pk-plan__name">{row.name} <code>{row.id}</code></span>
                <span className="pk-action" title={row.detail}>{row.actionLabel}</span>
                {row.detail && row.action !== 'create' && <span className="muted text-sm pk-plan__detail">{row.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {design.length > 0 && (
        <div className="pk-plan__group">
          <h4>Design settings</h4>
          <p className="text-sm" style={{ margin: 0 }}>Replaces the site’s {design.join(', ').toLowerCase()}.</p>
        </div>
      )}
      {fonts.length > 0 && (
        <div className="pk-plan__group">
          <h4>Font files <span className="muted">({fonts.length})</span></h4>
          <p className="text-sm" style={{ margin: 0 }}>{fonts.map(fontLine).join(', ')}</p>
        </div>
      )}
      {media.length > 0 && (
        <div className="pk-plan__group">
          <h4>Media <span className="muted">({media.length})</span></h4>
          <p className="text-sm" style={{ margin: 0 }}>Added to the media library. Demo images are marked <span className="pk-badge pk-badge--demo">Demo</span> and listed for replacement before the site is published.</p>
        </div>
      )}
    </div>
  );
}

export function ImportReportView({ siteId, report, result, onAnother }: { siteId: string; report: ImportReport; result: InspectResult; onAnother?: () => void }) {
  const sections = reportSections(report, siteId);
  return (
    <div className="stack pk-report" role="status">
      <p className="pk-done" style={{ margin: 0 }}><strong>Imported {result.package.name} {result.package.version}.</strong></p>
      {sections.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing new was needed: the site already had everything.</p>}
      <ul className="pk-report__list">
        {sections.map(section => (
          <li key={section.section}>
            {section.href ? <a href={section.href}><strong>{section.label}</strong></a> : <strong>{section.label}</strong>}
            {' '}<span className="muted text-sm">{reportCounts(section, report)}</span>
            {(section.created.length > 0 || section.renamed.length > 0) && (
              <ul className="pk-report__items">
                {[...section.created, ...section.renamed].slice(0, 30).map((item, index) => (
                  <li key={index}>{item.href ? <a href={item.href}>{item.label}</a> : item.label}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {(report.warnings ?? []).length > 0 && (
        <div className="pk-warnings" role="note" aria-label="Warnings"><ul>{report.warnings!.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>
      )}
      {(result.plan.media ?? []).length > 0 && (
        <p className="text-sm" style={{ margin: 0 }}>
          Replace the demo images before you publish: they are marked <span className="pk-badge pk-badge--demo">Demo</span> in the <a href={`/app/sites/${encodeURIComponent(siteId)}/media`}>media library</a>.
        </p>
      )}
      {onAnother && <div><button type="button" className="btn btn--secondary" onClick={onAnother}>Import another package</button></div>}
    </div>
  );
}
