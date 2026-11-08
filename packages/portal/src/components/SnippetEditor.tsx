// One live snippet: its content, or a week of weekday entries plus specific
// dates and a fallback for "By day/date" snippets. Saves the whole snippet
// with PUT and the updated_at it was read at, so a stale save is refused.
// The editing operations are pure helpers in snippet-model.ts.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, Copy, Info, Plus, Radio, Trash2 } from 'lucide-react';
import { WEEKDAYS, type Snippet, type SnippetError, type Weekday } from '@typeroll/shared';
import RichTextInput from './RichTextInput';
import { copyText } from './SiteFieldsEditor';
import {
  DEFAULT_TIME_ZONE, KIND_LABELS, WEEKDAY_NAMES, liveSupported, addDateRow, buildSnippet, clearWeek, copyWeekday, describeUpdated, draftSignature,
  localProblems, mapSnippetErrors, plainText, previewDays, removeDateRow, snippetSaveBody, sortDateRows, toDraft, todayIn, updateDateRow,
  type ErrorTarget, type SnippetDraft,
} from './snippet-model';
import { SNIPPETS_CSS } from './snippet-styles';
import TimeZoneNote from './TimeZoneNote';

interface Props {
  siteId: string;
  snippetId: string;
  canEdit: boolean;
  /** The site's time zone (`siteTimeZone(settings)`); the days and the preview follow it. */
  timeZone?: string;
  /** A server-loaded snippet; without it the editor loads it itself. */
  initial?: Snippet | null;
  /** For tests: the moment "today" is read from. */
  now?: Date;
}

interface LiveResult { published?: boolean; supported?: boolean; base_url?: string | null; url?: string; reason?: string }
interface SnippetResponse { snippet?: Snippet; live?: LiveResult; live_url?: string | null; live_reason?: string; error?: string; errors?: SnippetError[] }
interface Problem { kind: 'stale' | 'error' | 'missing'; message: string }

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (date: string) => { const [y, m, d] = date.split('-').map(Number); return DAY_FORMAT.format(new Date(Date.UTC(y!, m! - 1, d!, 12))); };

/** The message after a save: live within a minute, or why not. */
export function savedMessage(live: LiveResult | undefined): { kind: 'live' | 'later'; message: string } {
  if (live?.published) return { kind: 'live', message: 'Saved. Live on the site within a minute.' };
  const reason = live?.reason ? `${live.reason.replace(/\.?\s*$/, '.')} ` : '';
  return { kind: 'later', message: `Saved. ${reason}The site shows the change at the next publication.` };
}

export default function SnippetEditor({ siteId, snippetId, canEdit, timeZone: zoneProp, initial, now }: Props) {
  const timeZone = zoneProp || DEFAULT_TIME_ZONE;
  const listUrl = `/app/sites/${encodeURIComponent(siteId)}/snippets`;
  const apiUrl = `/api/sites/${encodeURIComponent(siteId)}/snippets/${encodeURIComponent(snippetId)}`;
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const [saved, setSaved] = useState<Snippet | null>(initial ?? null);
  const [draft, setDraft] = useState<SnippetDraft | null>(() => (initial ? toDraft(initial) : null));
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<Map<ErrorTarget, string[]>>(new Map());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'live' | 'later' | 'info'; message: string } | null>(null);
  const [liveSupport, setLiveSupport] = useState<LiveResult | null>(null);
  const [undo, setUndo] = useState<{ draft: SnippetDraft; label: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [today, setToday] = useState<Date | null>(now ?? null);
  const leaving = useRef(false);
  const pendingFocus = useRef<string | null>(null);

  function adopt(snippet: Snippet) {
    setSaved(snippet);
    setDraft(toDraft(snippet));
    setErrors(new Map());
    setUndo(null);
  }

  async function load(): Promise<void> {
    try {
      const response = await fetch(apiUrl);
      const body = await response.json().catch(() => ({})) as SnippetResponse & Partial<Snippet>;
      const snippet = body.snippet ?? (body.id ? body as Snippet : undefined);
      if (!response.ok || !snippet) {
        setProblem(response.status === 404
          ? { kind: 'missing', message: 'This snippet does not exist. It may have been deleted.' }
          : { kind: 'error', message: body.error ?? `Loading failed (${response.status})` });
        return;
      }
      adopt(snippet);
      // The read says where the live file is served; without an address, saves wait for the next publication.
      if (body.live_url === null) setLiveSupport({ supported: false, reason: body.live_reason });
      else if (body.live && body.live.published === undefined && !liveSupported(body.live)) setLiveSupport(body.live);
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Loading failed' });
    }
  }

  useEffect(() => { if (!initial) void load(); }, [apiUrl]);
  // Today is read in the browser so the server render and hydration agree.
  useEffect(() => { if (!now) setToday(new Date()); }, [now]);

  const kind = saved?.kind ?? 'html';
  const dirty = !!(saved && draft) && draftSignature(kind, draft) !== draftSignature(kind, toDraft(saved));

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { if (leaving.current) return; event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  useEffect(() => {
    if (!pendingFocus.current) return;
    document.getElementById(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  const built = useMemo(() => (saved && draft ? buildSnippet({ id: saved.id, kind: saved.kind }, draft) : null), [saved, draft]);
  const days = useMemo(() => (built && today && kind === 'dated' ? previewDays(built.snippet, timeZone, today) : []), [built, today, timeZone, kind]);

  function change(next: SnippetDraft) {
    setDraft(next);
    setNotice(null);
  }

  function bulk(next: SnippetDraft, label: string) {
    if (!draft) return;
    setUndo({ draft, label });
    change(next);
  }

  async function save() {
    if (!saved || !draft || !canEdit) return;
    const local = localProblems(draft, kind);
    if (local.length) {
      setErrors(mapSnippetErrors(local, []));
      setProblem({ kind: 'error', message: 'The snippet was not saved. Fix the problems marked below.' });
      return;
    }
    setSaving(true);
    setProblem(null);
    setNotice(null);
    const { sources } = buildSnippet({ id: saved.id, kind }, draft);
    try {
      const response = await fetch(apiUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snippetSaveBody({ id: saved.id, kind }, draft, saved.updated_at)),
      });
      const body = await response.json().catch(() => ({})) as SnippetResponse;
      if (!response.ok) {
        setErrors(body.errors?.length ? mapSnippetErrors(body.errors, sources) : new Map());
        setProblem(response.status === 409
          ? { kind: 'stale', message: body.error ?? 'Someone else saved this snippet after you opened it.' }
          : { kind: 'error', message: body.errors?.length ? 'The snippet was not saved. Fix the problems marked below.' : body.error ?? `Saving failed (${response.status})` });
        return;
      }
      adopt(body.snippet ?? { ...buildSnippet({ id: saved.id, kind }, draft).snippet, updated_at: saved.updated_at });
      setNotice(savedMessage(body.live));
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Saving failed' });
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    setProblem(null);
    await load();
    setNotice({ kind: 'info', message: 'Loaded the saved snippet.' });
  }

  async function remove() {
    setDeleting(true);
    setProblem(null);
    try {
      const response = await fetch(`${apiUrl}${saved?.updated_at ? `?expected_updated_at=${encodeURIComponent(saved.updated_at)}` : ''}`, { method: 'DELETE' });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Deleting failed (${response.status})`);
      leaving.current = true;
      window.location.href = listUrl;
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Deleting failed' });
      setDeleting(false);
    }
  }

  const back = <a href={listUrl} className="sn-muted sn-small">← Snippets</a>;

  if (!saved || !draft) {
    return (
      <div className="snippets">
        <div className="sn-header__text">{back}<h1>Snippet</h1></div>
        {problem
          ? <div className="sn-problem" role="alert"><p>{problem.message}</p>{problem.kind === 'missing' && <p><a href={listUrl}>Back to the snippets</a></p>}</div>
          : <p className="sn-muted">Loading the snippet…</p>}
        <style dangerouslySetInnerHTML={{ __html: SNIPPETS_CSS }} />
      </div>
    );
  }

  const format = draft.format;
  const general = errors.get('') ?? [];
  const nameErrors = errors.get('name') ?? [];
  const todayDate = todayIn(timeZone, today ?? new Date());

  return (
    <div className="snippets">
      <div className="sn-header">
        <div className="sn-header__text">
          {back}
          <h1>{saved.name || saved.id}</h1>
          <p className="sn-muted sn-small">
            {KIND_LABELS[kind]} snippet <code>{saved.id}</code> · Last updated {describeUpdated(saved)}
          </p>
        </div>
      </div>

      <div className="sn-bar">
        <span className="sn-status" role="status">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        {canEdit && <button type="button" className="btn btn--sm" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save snippet'}</button>}
      </div>

      {problem && (
        <div className={`sn-problem${problem.kind === 'stale' ? ' sn-problem--stale' : ''}`} role="alert">
          <p>{problem.message}</p>
          {problem.kind === 'stale' && (
            <p className="sn-row">
              <button type="button" className="btn btn--secondary btn--sm" onClick={reload}>Load the saved snippet (drops your changes)</button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setProblem(null)}>Keep editing</button>
            </p>
          )}
        </div>
      )}
      {notice && (
        <p className={`sn-notice${notice.kind === 'later' ? ' sn-notice--warn' : notice.kind === 'info' ? ' sn-notice--info' : ''}`} role="status">
          {notice.kind === 'live' ? <Radio size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />} {notice.message}
        </p>
      )}
      {liveSupport && !notice && (
        <p className="sn-notice sn-notice--warn"><Info size={16} aria-hidden="true" />
          {liveSupport.reason ? `${liveSupport.reason.replace(/\.?\s*$/, '.')} ` : 'Live updating is not available for this site. '}Saved changes show on the site at the next publication.
        </p>
      )}
      {!canEdit && <p className="sn-muted sn-small">You can view this snippet. Changing it needs write access to the site.</p>}
      {general.length > 0 && <ul className="sn-errors" role="alert">{general.map((message) => <li key={message}>{message}</li>)}</ul>}

      <div className="sn-grid">
        <div className="sn-main">
          <section className="sn-card" aria-labelledby={`${domId}-settings`}>
            <h2 id={`${domId}-settings`} className="sn-sr">Settings</h2>
            <div className="sn-field">
              <label htmlFor={`${domId}-name`}>Name</label>
              <input id={`${domId}-name`} value={draft.name} maxLength={120} disabled={!canEdit} aria-invalid={nameErrors.length > 0 || !draft.name.trim()}
                onChange={(event) => change({ ...draft, name: event.target.value })} />
              {nameErrors.map((message) => <p key={message} className="sn-error">{message}</p>)}
              <span className="sn-muted sn-small">Only editors see the name. The id <code>{saved.id}</code> stays the same.</span>
            </div>
          </section>

          {kind !== 'dated' ? (
            <section className="sn-card" aria-labelledby={`${domId}-content`}>
              <h2 id={`${domId}-content`}>Content</h2>
              <ContentInput id={`${domId}-content-input`} label="Content" format={format} value={draft.content} disabled={!canEdit}
                onChange={(content) => change({ ...draft, content })} />
              {(errors.get('content') ?? []).map((message) => <p key={message} className="sn-error">{message}</p>)}
            </section>
          ) : (
            <>
              <section className="sn-card" aria-labelledby={`${domId}-week`}>
                <div className="sn-section-head">
                  <h2 id={`${domId}-week`}>Every week</h2>
                  {canEdit && (
                    <span className="sn-row">
                      <button type="button" className="btn btn--secondary btn--sm" onClick={() => bulk(copyWeekday(draft), 'Copied Monday to Tuesday–Friday.')}>Copy Monday to Tuesday–Friday</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => bulk(clearWeek(draft), 'Cleared the week.')}>Clear the week</button>
                    </span>
                  )}
                </div>
                <p className="sn-muted sn-small">What each weekday shows. Leave a day empty to show the fallback below.</p>
                <TimeZoneNote siteId={siteId} zone={timeZone} className="sn-muted" />
                {undo && (
                  <p className="sn-row sn-small" role="status">{undo.label}
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => { change(undo.draft); setUndo(null); }}>Undo</button>
                  </p>
                )}
                <ol className="sn-week">
                  {WEEKDAYS.map((day) => {
                    const messages = errors.get(`weekday:${day}`) ?? [];
                    const id = `${domId}-day-${day}`;
                    return (
                      <li key={day} className={`sn-day${messages.length ? ' sn-day--error' : ''}`}>
                        <div className="sn-day__label">
                          <label htmlFor={id}>{WEEKDAY_NAMES[day]}</label>
                        </div>
                        <div className="sn-day__body">
                          <ContentInput id={id} label={WEEKDAY_NAMES[day]} format={format} value={draft.week[day]} disabled={!canEdit} compact
                            onChange={(value) => change({ ...draft, week: { ...draft.week, [day]: value } })} />
                          {messages.map((message) => <p key={message} className="sn-error">{message}</p>)}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>

              <section className="sn-card" aria-labelledby={`${domId}-dates`}>
                <div className="sn-section-head">
                  <h2 id={`${domId}-dates`}>Specific dates</h2>
                  <span className="sn-muted sn-small">A date wins over its weekday</span>
                </div>
                <p className="sn-muted sn-small">For holidays, a special menu or a day you're closed. A date without content is left out when you save.</p>
                {draft.dates.length === 0 && <p className="sn-muted sn-small">No specific dates.</p>}
                <ol className="sn-dates" aria-labelledby={`${domId}-dates`}>
                  {draft.dates.map((row, index) => {
                    const messages = errors.get(`date:${row.key}`) ?? [];
                    const name = row.date ? dayLabel(row.date) : `date ${index + 1}`;
                    const id = `${domId}-date-${row.key}`;
                    return (
                      <li key={row.key} className={`sn-date${messages.length ? ' sn-date--error' : ''}`}>
                        <div className="sn-field">
                          <label htmlFor={`${id}-date`} className="sn-label">Date</label>
                          <input id={`${id}-date`} type="date" value={row.date} disabled={!canEdit} aria-invalid={messages.length > 0}
                            onChange={(event) => change(updateDateRow(draft, row.key, { date: event.target.value }))} />
                          {row.date && <span className="sn-muted sn-small">{dayLabel(row.date)}</span>}
                        </div>
                        <div className="sn-day__body">
                          <span className="sn-label" id={`${id}-label`}>Content</span>
                          <ContentInput id={`${id}-content`} label={`Content for ${name}`} format={format} value={row.content} disabled={!canEdit} compact
                            onChange={(content) => change(updateDateRow(draft, row.key, { content }))} />
                        </div>
                        {canEdit && (
                          <button type="button" className="sn-iconbtn" aria-label={`Remove ${name}`} title="Remove"
                            onClick={() => change(removeDateRow(draft, row.key))}><Trash2 size={15} aria-hidden="true" /></button>
                        )}
                        {messages.length > 0 && <ul className="sn-errors sn-date__errors" role="alert">{messages.map((message) => <li key={message}>{message}</li>)}</ul>}
                      </li>
                    );
                  })}
                </ol>
                {canEdit && (
                  <p className="sn-row">
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => {
                      const next = addDateRow(draft, todayDate);
                      change(next);
                      pendingFocus.current = `${domId}-date-${next.dates[next.dates.length - 1]!.key}-date`;
                    }}><Plus size={14} aria-hidden="true" /> Add a date</button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => change({ ...draft, dates: sortDateRows(draft.dates) })}>Sort by date</button>
                  </p>
                )}
              </section>

              <section className="sn-card" aria-labelledby={`${domId}-fallback`}>
                <h2 id={`${domId}-fallback`}>When there is nothing for the day</h2>
                <p className="sn-muted sn-small">Shown on a day with no weekday or date content. Leave it empty to show nothing.</p>
                <ContentInput id={`${domId}-fallback-input`} label="Fallback content" format={format} value={draft.fallback} disabled={!canEdit} compact
                  onChange={(fallback) => change({ ...draft, fallback })} />
                {(errors.get('fallback') ?? []).map((message) => <p key={message} className="sn-error">{message}</p>)}
              </section>
            </>
          )}
        </div>

        <aside className="sn-side">
          {kind === 'dated' && (
            <section className="sn-card" aria-labelledby={`${domId}-preview`}>
              <h2 id={`${domId}-preview`}><CalendarDays size={16} aria-hidden="true" /> Show this week</h2>
              <p className="sn-muted sn-small">What the site shows on each of the next 7 days{dirty ? ', with your unsaved changes' : ''}, in {timeZone}.</p>
              {days.length === 0 ? <p className="sn-muted sn-small">Working out the days…</p> : (
                <ol className="sn-preview">
                  {days.map((day, index) => {
                    const text = plainText(day.content, format);
                    return (
                      <li key={day.date}>
                        <span className="sn-preview__head">
                          <span>{index === 0 ? 'Today, ' : index === 1 ? 'Tomorrow, ' : ''}{dayLabel(day.date)}</span>
                          <span className={`sn-badge${day.source === 'date' ? ' sn-badge--date' : ''}`}>
                            {day.source === 'date' ? 'Date' : day.source === 'weekday' ? WEEKDAY_NAMES[day.weekday] : day.source === 'fallback' ? 'Fallback' : 'Nothing'}
                          </span>
                        </span>
                        <span className={`sn-preview__content${text ? '' : ' sn-preview__content--empty'}`}>{text || 'Shows nothing'}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          )}

          <section className="sn-card" aria-labelledby={`${domId}-show`}>
            <h2 id={`${domId}-show`}>How to show it</h2>
            <p className="sn-small">
              Add a <strong>Snippet</strong> block to a page, a page template or a global block and set <strong>Snippet</strong> to:
            </p>
            <div className="sn-show">
              <code>{saved.id}</code>
              <CopyButton text={saved.id} label={`Copy the id ${saved.id}`} />
            </div>
            <p className="sn-muted sn-small">
              The block shows the content from the latest publication and then fetches the newest saved version, so a change shows
              without publishing the site.{kind === 'dated' ? ' Each visitor sees the entry for today.' : ''}
            </p>
          </section>

          {canEdit && (
            <section className="sn-card" aria-labelledby={`${domId}-delete`}>
              <h2 id={`${domId}-delete`}>Delete snippet</h2>
              {!confirmDelete ? (
                <p><button type="button" className="btn btn--secondary btn--sm" onClick={() => { setConfirmDelete(true); pendingFocus.current = `${domId}-delete-confirm`; }}>Delete this snippet…</button></p>
              ) : (
                <div className="sn-confirm" role="group" aria-label="Confirm deleting the snippet">
                  <p className="sn-small">
                    Delete “{saved.name || saved.id}”? Pages that show it stop showing it the next time they fetch it, within a minute.
                    Their Snippet blocks stay until you remove them.
                  </p>
                  <p className="sn-row">
                    <button id={`${domId}-delete-confirm`} type="button" className="btn btn--danger btn--sm" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete snippet'}</button>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </p>
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
      <style dangerouslySetInnerHTML={{ __html: SNIPPETS_CSS }} />
    </div>
  );
}

/** Rich text for html snippets, a text area for text; read-only shows plain text. */
function ContentInput({ id, label, format, value, disabled, compact, onChange }: {
  id: string; label: string; format: 'html' | 'text'; value: string; disabled: boolean; compact?: boolean; onChange: (value: string) => void;
}) {
  if (disabled) {
    const text = plainText(value, format);
    return <div id={id} className={`sn-readonly${text ? '' : ' sn-muted'}`} aria-label={label}>{text || 'Empty'}</div>;
  }
  if (format === 'html') return <RichTextInput id={id} label={label} value={value} onChange={onChange} />;
  return <textarea id={id} aria-label={label} rows={compact ? 3 : 8} value={value} onChange={(event) => onChange(event.target.value)} />;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <>
      <button type="button" className="sn-iconbtn" aria-label={label} title="Copy"
        onClick={async () => { setState((await copyText(text)) ? 'copied' : 'failed'); window.setTimeout(() => setState('idle'), 2000); }}>
        {state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <span className="sn-sr" aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copying failed: select the id and copy it' : ''}</span>
      {state === 'failed' && <span className="sn-error">Select the id and copy it.</span>}
    </>
  );
}
