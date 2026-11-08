// Site fields page: settings pages (groups of fields) shared by the whole
// site. Editors fill in the values of the pages they may change; admins also
// define the pages and their fields. Values save per settings page (PATCH),
// definitions save together (PUT); both send the updated_at they were read
// at so a stale save is refused. The editing operations are pure helpers in
// site-fields-model.ts.

import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Copy, Lock, Plus, Trash2 } from 'lucide-react';
import {
  MAIN_VERSION_ID, MAX_SITE_FIELD_GROUPS, MAX_SITE_FIELDS, WEEKDAYS, localDate, siteTimeZone, validateSiteFieldGroups, validateSiteFieldValues,
  type FieldDefinition, type FieldType, type SiteFieldError, type SiteFieldGroup, type SiteFields, type Weekday,
} from '@typeroll/shared';
import FieldInput from './FieldInput';
import HistoryPanel from './HistoryPanel';
import TimeZoneNote from './TimeZoneNote';
import { suggestFieldName } from '../lib/block-type-builder';
import {
  SITE_FIELD_TYPE_LABELS, WEEKDAY_LABELS, MAX_EXCEPTIONS,
  addFieldTo, addUpcomingException, breakProblem, hasBreak, hoursNote, setHoursNote, withoutBreak, duplicateExceptionDates, exceptionOrder, isPastDate, removePastExceptions, addGroup, addOpeningHours, canAddField, canAddGroup, canEditGroup, canMoveField, copyDay,
  countSiteFields, definitionKey, definitionsPutBody, describeProblemPath, describeValue, exceptionRows, fieldNameProblem,
  fieldUsage, groupHasDefinitionErrors, groupIdProblem, groupValues, isOpeningHours, mapDefinitionErrors, mapValueErrors,
  moveFieldAt, moveInList, openingHoursRows, optionsFromText, optionsToText, problemsUnder, reindexKeys, removeException,
  removeFieldAt, removeGroup, setDay, siteFieldNames, suggestGroupId, timeProblem, typeChange, typesAtDepth, updateException,
  updateFieldAt, updateGroup, valuesLostBySave, valuesPatchBody,
  type DayRow, type DefinitionErrors, type ExceptionRow, type FieldPath, type ValueProblem,
} from './site-fields-model';

type Permission = 'read' | 'write' | 'admin';

/** A top-level field marked live updates on the site without a publication. */
export const isLiveField = (field: FieldDefinition): boolean => (field as FieldDefinition & { live?: boolean }).live === true;

interface Props {
  siteId: string;
  /** The version being edited; a non-main version is sent as `?version=`. */
  versionId?: string;
  permission: Permission;
  /** Defining settings pages is design work: an administrator or builder (SiteContext.design). Default: admin permission. */
  canDefine?: boolean;
  /** Server-loaded fields; without them the editor loads them itself. */
  initial?: SiteFields | null;
  /** The site's time zone (`siteTimeZone(settings)`), which opening hours' "today" follows. */
  timeZone?: string;
  /** For tests: the moment "today" is read from (else the browser's clock after loading). */
  now?: Date;
}

interface Problem { kind: 'stale' | 'error'; message: string }
interface SaveResponse extends Partial<Omit<SiteFields, 'updated_at'>> { updated_at?: string | null; site_fields?: SiteFields; error?: string; errors?: SiteFieldError[] }

const EMPTY_ERRORS: DefinitionErrors = { general: [], byKey: new Map() };

/** The site fields from a response body, whether wrapped or not. */
function readFields(body: SaveResponse): SiteFields | null {
  const source = body.site_fields ?? body;
  return Array.isArray(source.groups) ? { groups: source.groups, values: source.values ?? {}, ...(source.updated_at ? { updated_at: source.updated_at } : {}) } : null;
}

export default function SiteFieldsEditor({ siteId, versionId, permission, canDefine, initial, timeZone, now }: Props) {
  const isAdmin = canDefine ?? permission === 'admin';
  const query = versionId && versionId !== MAIN_VERSION_ID ? `?version=${encodeURIComponent(versionId)}` : '';
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/site-fields${query}`;
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const [saved, setSaved] = useState<SiteFields | null>(initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [active, setActive] = useState<string>('');
  const [mode, setMode] = useState<'values' | 'define' | 'history'>('values');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [valueErrors, setValueErrors] = useState<Record<string, Map<string, ValueProblem[]>>>({});
  const [notice, setNotice] = useState('');
  // Define mode.
  const [defGroups, setDefGroups] = useState<SiteFieldGroup[]>([]);
  const [defActive, setDefActive] = useState(0);
  const [defErrors, setDefErrors] = useState<DefinitionErrors>(EMPTY_ERRORS);
  const [confirmLoss, setConfirmLoss] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const pendingFocus = useRef<string | null>(null);
  // Today in the site's time zone, read in the browser so hydration matches.
  const [today, setToday] = useState<string | null>(() => (now ? todayIn(timeZone, now) : null));
  useEffect(() => { if (!now) setToday(todayIn(timeZone)); }, [now, timeZone]);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetch(endpoint)
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as SaveResponse;
        if (cancelled) return;
        const fields = response.ok ? readFields(body) : null;
        if (!fields) setLoadError(body.error ?? `Loading failed (${response.status})`);
        else setSaved(fields);
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Loading failed'); });
    return () => { cancelled = true; };
  }, [endpoint, initial]);

  const groups = saved?.groups ?? [];
  const values = saved?.values ?? {};

  // The tab follows the address (#group-id) so a reload or a shared link opens it.
  useEffect(() => {
    if (!saved) return;
    const fromHash = typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.slice(1)) : '';
    setActive((current) => (groups.some((group) => group.id === current) ? current
      : groups.some((group) => group.id === fromHash) ? fromHash : groups[0]?.id ?? ''));
  }, [saved]);

  const draftOf = (group: SiteFieldGroup) => drafts[group.id] ?? groupValues(group, values);
  const dirtyGroups = useMemo(() => groups.filter((group) => drafts[group.id]
    && JSON.stringify(drafts[group.id]) !== JSON.stringify(groupValues(group, values))).map((group) => group.id), [groups, drafts, values]);
  const defDirty = mode === 'define' && JSON.stringify(defGroups) !== JSON.stringify(groups);
  const anyDirty = dirtyGroups.length > 0 || defDirty;

  useEffect(() => {
    if (!anyDirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [anyDirty]);

  useEffect(() => {
    if (!pendingFocus.current) return;
    document.getElementById(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  function choose(id: string) {
    setActive(id);
    setNotice('');
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  }

  function changeValue(group: SiteFieldGroup, name: string, value: unknown) {
    setDrafts((current) => ({ ...current, [group.id]: { ...(current[group.id] ?? groupValues(group, values)), [name]: value } }));
    setNotice('');
  }

  function adopt(next: SiteFields) {
    setSaved(next);
    setDrafts({});
  }

  async function saveGroup(group: SiteFieldGroup) {
    const draft = draftOf(group);
    const body = valuesPatchBody(group, draft, saved?.updated_at);
    const local = validateSiteFieldValues(groups, body.values, [group.id]);
    if (local.errors.length) {
      setValueErrors((current) => ({ ...current, [group.id]: mapValueErrors(local.errors) }));
      setProblem({ kind: 'error', message: `“${group.label}” was not saved. Fix the problems marked below.` });
      return;
    }
    setSaving(true);
    setProblem(null);
    setNotice('');
    try {
      const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok) {
        if (result.errors?.length) setValueErrors((current) => ({ ...current, [group.id]: mapValueErrors(result.errors!) }));
        setProblem(response.status === 409
          ? { kind: 'stale', message: result.error ?? 'Someone else saved the site fields after you opened them.' }
          : { kind: 'error', message: result.errors?.length ? `“${group.label}” was not saved. Fix the problems marked below.` : result.error ?? `Saving failed (${response.status})` });
        return;
      }
      const next = readFields(result) ?? { groups, values: { ...values, ...groupValues(group, draft) }, updated_at: saved?.updated_at };
      setSaved(next);
      setDrafts((current) => { const copy = { ...current }; delete copy[group.id]; return copy; });
      setValueErrors((current) => { const copy = { ...current }; delete copy[group.id]; return copy; });
      const live = group.fields.filter(isLiveField).length;
      setNotice(live === 0 ? `Saved “${group.label}”. Published pages show the change after the next publish.`
        : live === group.fields.length ? `Saved “${group.label}”. Live fields show on the site within a minute.`
        : `Saved “${group.label}”. Live fields show on the site within a minute; the others after the next publish.`);
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Saving failed' });
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    setProblem(null);
    try {
      const response = await fetch(endpoint);
      const body = await response.json().catch(() => ({})) as SaveResponse;
      const fields = response.ok ? readFields(body) : null;
      if (!fields) { setProblem({ kind: 'error', message: body.error ?? 'Could not load the site fields' }); return; }
      adopt(fields);
      setValueErrors({});
      if (mode === 'define') { setDefGroups(fields.groups); setDefErrors(EMPTY_ERRORS); setConfirmLoss(false); }
      setNotice('Loaded the saved site fields.');
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Could not load the site fields' });
    }
  }

  function startDefining(createFirst = false) {
    const start = createFirst && groups.length === 0 ? addGroup(groups, 'Site settings') : groups;
    setDefGroups(start);
    const index = Math.max(0, groups.findIndex((group) => group.id === active));
    setDefActive(createFirst ? start.length - 1 : index);
    setDefErrors(EMPTY_ERRORS);
    setConfirmLoss(false);
    setOpen(new Set());
    setProblem(null);
    setNotice('');
    setMode('define');
  }

  function stopDefining() {
    setMode('values');
    setDefErrors(EMPTY_ERRORS);
    setProblem(null);
  }

  const lost = mode === 'define' ? valuesLostBySave(groups, defGroups, values) : [];

  async function saveDefinitions() {
    const local = validateSiteFieldGroups(defGroups);
    if (local.errors.length) {
      showDefinitionErrors(local.errors);
      return;
    }
    if (lost.length && !confirmLoss) return;
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(definitionsPutBody(defGroups, saved?.updated_at)) });
      const result = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok) {
        if (result.errors?.length) showDefinitionErrors(result.errors);
        else setProblem(response.status === 409
          ? { kind: 'stale', message: result.error ?? 'Someone else saved the site fields after you opened them.' }
          : { kind: 'error', message: result.error ?? `Saving failed (${response.status})` });
        return;
      }
      const next = readFields(result) ?? { groups: definitionsPutBody(defGroups, undefined).groups, values, updated_at: saved?.updated_at };
      adopt(next);
      setDefGroups(next.groups);
      setDefErrors(EMPTY_ERRORS);
      setConfirmLoss(false);
      setMode('values');
      const current = next.groups[defActive]?.id ?? next.groups[0]?.id ?? '';
      setActive(current);
      setNotice('Saved the settings pages and their fields.');
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Saving failed' });
    } finally {
      setSaving(false);
    }
  }

  function showDefinitionErrors(errors: SiteFieldError[]) {
    const mapped = mapDefinitionErrors(errors);
    setDefErrors(mapped);
    // Open the fields with problems and go to the first page that has one.
    setOpen((current) => {
      const next = new Set(current);
      for (const key of mapped.byKey.keys()) {
        const [group, path] = key.split(':');
        if (!path) continue;
        const parts = path.split('.');
        for (let i = 1; i <= parts.length; i++) next.add(`${group}:${parts.slice(0, i).join('.')}`);
      }
      return next;
    });
    const firstGroup = defGroups.findIndex((_, index) => groupHasDefinitionErrors(mapped, index));
    if (firstGroup >= 0) setDefActive(firstGroup);
    setProblem({ kind: 'error', message: 'The fields were not saved. Fix the problems marked below.' });
  }

  // ─── Rendering ──────────────────────────────────────────────────────

  if (!saved) {
    return (
      <div className="site-fields">
        <Header />
        {loadError ? <p className="sf-error" role="alert">Couldn't load the site fields: {loadError}</p> : <p className="sf-muted">Loading the site fields…</p>}
        <style dangerouslySetInnerHTML={{ __html: SITE_FIELDS_CSS }} />
      </div>
    );
  }

  const problemBox = problem && (
    <div className={`sf-problem sf-problem--${problem.kind}`} role="alert">
      <p>{problem.message}</p>
      {problem.kind === 'stale' && (
        <p className="sf-row">
          <button type="button" className="btn btn--secondary btn--sm" onClick={reload}>Load the saved fields (drops your changes)</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setProblem(null)}>Keep editing</button>
        </p>
      )}
    </div>
  );

  if (mode === 'define') {
    const group = defGroups[defActive];
    return (
      <div className="site-fields">
        <Header>
          <span className="sf-status" role="status">{saving ? 'Saving…' : defDirty ? 'Unsaved changes' : 'No changes'}</span>
          <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={stopDefining}>{defDirty ? 'Discard changes' : 'Done'}</button>
          <button type="button" className="btn btn--sm" disabled={saving || !defDirty || (lost.length > 0 && !confirmLoss)} onClick={saveDefinitions}>Save fields</button>
        </Header>
        <p className="sf-muted sf-intro">
          Define the settings pages and their fields. Editors fill in the values; a template shows them with <code>{'{{site.fields.<name>}}'}</code> or
          a <strong>Site field</strong> block. Field names are shared by the whole site, so each is used once.
        </p>
        {problemBox}
        {defErrors.general.length > 0 && <ul className="sf-errors">{defErrors.general.map((message) => <li key={message}>{message}</li>)}</ul>}
        {lost.length > 0 && (
          <div className="sf-problem sf-problem--stale" role="alert">
            <p>Saving deletes the saved {lost.length === 1 ? 'value' : 'values'} of {lost.map((field) => `“${field.label}” (${field.name})`).join(', ')}: {lost.length === 1 ? 'the field is' : 'the fields are'} removed or renamed.</p>
            <label className="sf-check"><input type="checkbox" checked={confirmLoss} onChange={(event) => setConfirmLoss(event.target.checked)} /> Delete {lost.length === 1 ? 'this value' : 'these values'} when I save</label>
          </div>
        )}
        <div className="sf-tabs" role="tablist" aria-label="Settings pages">
          {defGroups.map((g, index) => (
            <button key={index} type="button" role="tab" aria-selected={index === defActive} className={index === defActive ? 'is-active' : ''}
              onClick={() => setDefActive(index)}>
              {g.label || g.id || 'Untitled'}{groupHasDefinitionErrors(defErrors, index) && <span className="sf-dot" aria-label=" (has problems)" />}
            </button>
          ))}
          <button type="button" className="sf-tabs__add" disabled={!canAddGroup(defGroups)}
            title={canAddGroup(defGroups) ? undefined : `At most ${MAX_SITE_FIELD_GROUPS} settings pages`}
            onClick={() => { setDefGroups(addGroup(defGroups, 'New settings page')); setDefActive(defGroups.length); pendingFocus.current = `${domId}-group-label`; }}>
            <Plus size={14} aria-hidden="true" /> New settings page
          </button>
        </div>
        {group ? (
          <GroupDefinition key={defActive} domId={domId} groups={defGroups} groupIndex={defActive} savedNames={new Set(siteFieldNames(groups))} savedGroupIds={new Set(groups.map((g) => g.id))}
            values={values} errors={defErrors} open={open} setOpen={setOpen} pendingFocus={pendingFocus}
            onChange={setDefGroups}
            onRemove={() => { setDefGroups(removeGroup(defGroups, defActive)); setDefActive(Math.max(0, defActive - 1)); setOpen(new Set()); }}
            onMove={(delta) => { setDefGroups(moveInList(defGroups, defActive, defActive + delta)); setDefActive(defActive + delta); setOpen(new Set()); }} />
        ) : (
          <div className="sf-card sf-empty">
            <p>No settings pages. Add one with <strong>New settings page</strong>, or save to remove every site field.</p>
          </div>
        )}
        <style dangerouslySetInnerHTML={{ __html: SITE_FIELDS_CSS }} />
      </div>
    );
  }

  if (mode === 'history') {
    return (
      <div className="site-fields">
        <Header><button type="button" className="btn btn--secondary btn--sm" onClick={() => setMode('values')}>Back to the values</button></Header>
        <section className="sf-card">
          <h2>History</h2>
          <p className="sf-muted sf-small">Every save of the definitions or the values. Restoring one reloads the page.</p>
          <HistoryPanel endpoint={`/api/sites/${encodeURIComponent(siteId)}/site-fields/revisions${query}`} />
        </section>
        <style dangerouslySetInnerHTML={{ __html: SITE_FIELDS_CSS }} />
      </div>
    );
  }

  const group = groups.find((g) => g.id === active) ?? groups[0];
  return (
    <div className="site-fields">
      <Header>
        {group && <span className="sf-status" role="status">{saving ? 'Saving…' : dirtyGroups.length ? `Unsaved changes in ${dirtyGroups.length === 1 ? '1 page' : `${dirtyGroups.length} pages`}` : 'All changes saved'}</span>}
        {isAdmin && saved.updated_at && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={dirtyGroups.length > 0}
            title={dirtyGroups.length ? 'Save or discard the values first' : undefined} onClick={() => { setNotice(''); setProblem(null); setMode('history'); }}>History</button>
        )}
        {isAdmin && groups.length > 0 && (
          <button type="button" className="btn btn--secondary btn--sm" disabled={dirtyGroups.length > 0}
            title={dirtyGroups.length ? 'Save or discard the values first' : undefined} onClick={() => startDefining()}>Define fields</button>
        )}
      </Header>
      {problemBox}
      {notice && <p className="sf-notice" role="status"><Check size={16} aria-hidden="true" /> {notice}</p>}
      {groups.length === 0 ? (
        <div className="sf-card sf-empty">
          <h2>No settings pages yet</h2>
          <p>
            Settings pages hold information the whole site shares: a phone number, an address, opening hours, a switch that shows a booking
            button. Fill them in once and every page that uses them follows when you change them.
          </p>
          <p>
            A template shows a value with <code>{'{{site.fields.phone}}'}</code> or a <strong>Site field</strong> block, and a condition such as
            <code> site.fields.show_booking</code> shows or hides a block.
          </p>
          {isAdmin
            ? <p><button type="button" className="btn" onClick={() => startDefining(true)}><Plus size={16} aria-hidden="true" /> Create a settings page</button></p>
            : <p className="sf-muted">An administrator of the site creates settings pages and their fields.</p>}
        </div>
      ) : (
        <>
          <div className="sf-tabs" role="tablist" aria-label="Settings pages">
            {groups.map((g) => (
              <button key={g.id} type="button" role="tab" id={`${domId}-tab-${g.id}`} aria-selected={g.id === group!.id}
                aria-controls={`${domId}-panel`} className={g.id === group!.id ? 'is-active' : ''} onClick={() => choose(g.id)}>
                {g.access === 'admin' && <Lock size={13} aria-label="Administrators only" />}
                {g.label}
                {dirtyGroups.includes(g.id) && <span className="sf-dot" aria-label=" (unsaved changes)" />}
              </button>
            ))}
          </div>
          {group && (
            <GroupValues key={group.id} id={`${domId}-panel`} labelledBy={`${domId}-tab-${group.id}`} siteId={siteId} group={group}
              draft={draftOf(group)} editable={canEditGroup(group, permission)} permission={permission} saving={saving} timeZone={timeZone} today={today}
              dirty={dirtyGroups.includes(group.id)} errors={valueErrors[group.id] ?? new Map()}
              onChange={(name, value) => changeValue(group, name, value)}
              onSave={() => saveGroup(group)}
              onDiscard={() => { setDrafts((current) => { const copy = { ...current }; delete copy[group.id]; return copy; }); setValueErrors((current) => { const copy = { ...current }; delete copy[group.id]; return copy; }); setProblem(null); }} />
          )}
        </>
      )}
      <style dangerouslySetInnerHTML={{ __html: SITE_FIELDS_CSS }} />
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="sf-header">
      <div>
        <h1>Site fields</h1>
        <p className="sf-muted">Information the whole site shares, kept in one place.</p>
      </div>
      {children && <div className="sf-header__actions">{children}</div>}
    </div>
  );
}

// ─── Values ─────────────────────────────────────────────────────────────

function GroupValues({ id, labelledBy, siteId, group, draft, editable, permission, saving, timeZone, today, dirty, errors, onChange, onSave, onDiscard }: {
  id: string; labelledBy: string; siteId: string; group: SiteFieldGroup; draft: Record<string, unknown>; editable: boolean; permission: Permission;
  timeZone?: string; today: string | null;
  saving: boolean; dirty: boolean; errors: Map<string, ValueProblem[]>;
  onChange: (name: string, value: unknown) => void; onSave: () => void; onDiscard: () => void;
}) {
  const general = errors.get('') ?? [];
  return (
    <section id={id} role="tabpanel" aria-labelledby={labelledBy} className="sf-card sf-panel">
      <div className="sf-panel__head">
        <div>
          <h2>{group.label}</h2>
          {group.description && <p className="sf-muted">{group.description}</p>}
        </div>
        {!editable && (
          <p className="sf-readonly"><Lock size={14} aria-hidden="true" />
            {permission === 'read' ? 'You can view these values. Changing them needs write access to the site.' : 'Only administrators change these values.'}
          </p>
        )}
      </div>
      {general.length > 0 && <ul className="sf-errors" role="alert">{general.map((problem) => <li key={problem.path + problem.message}>{problem.message}</li>)}</ul>}
      {group.fields.length === 0 && <p className="sf-muted">This settings page has no fields yet.</p>}
      <div className="sf-fields">
        {group.fields.map((field) => {
          const problems = errors.get(field.name) ?? [];
          const value = draft[field.name];
          return (
            <div key={field.name} className={`sf-field${problems.length ? ' sf-field--error' : ''}`}>
              {isOpeningHours(field)
                ? <OpeningHoursInput siteId={siteId} timeZone={timeZone} today={today} field={field} value={value} disabled={!editable} problems={problems} onChange={(next) => onChange(field.name, next)} />
                : editable
                  ? <FieldInput siteId={siteId} field={field} value={value} onChange={(next) => onChange(field.name, next)} />
                  : <ReadOnlyValue field={field} value={value} />}
              {!isOpeningHours(field) && problems.length > 0 && (
                <ul className="sf-errors" role="alert">
                  {problems.map((problem) => (
                    <li key={problem.path + problem.message}>{problem.path ? `${describeProblemPath(field, problem.path)}: ` : ''}{problem.message}</li>
                  ))}
                </ul>
              )}
              {isLiveField(field) && <p className="sf-live-note"><span className="sf-live">Live</span> <span className="sf-muted">Site field blocks show a saved value within a minute, without publishing.</span></p>}
              <UsageHint field={field} />
            </div>
          );
        })}
      </div>
      {editable && group.fields.length > 0 && (
        <div className="sf-panel__actions">
          <button type="button" className="btn" disabled={saving || !dirty} onClick={onSave}>{saving ? 'Saving…' : `Save ${group.label}`}</button>
          {dirty && <button type="button" className="btn btn--ghost" disabled={saving} onClick={onDiscard}>Discard changes</button>}
        </div>
      )}
    </section>
  );
}

function ReadOnlyValue({ field, value }: { field: FieldDefinition; value: unknown }) {
  return (
    <div className="sf-readonly-value">
      <span className="sf-label">{field.label}</span>
      <span>{describeValue(field, value)}</span>
    </div>
  );
}

/**
 * A row's break (behind "Add break" until it has one) and, for weekdays, its
 * comment shown to visitors. Date exceptions keep their comment in the row.
 */
function RowExtras({ rowKey, name, row, disabled, breakOpen, setBreakOpen, commentPlaceholder, onChange }: {
  rowKey: string; name: string; row: DayRow | ExceptionRow; disabled: boolean;
  breakOpen: Set<string>; setBreakOpen: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Given for weekdays: shows the comment input. */
  commentPlaceholder?: string;
  onChange: (patch: Partial<DayRow & ExceptionRow>) => void;
}) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const open = hasBreak(row) || breakOpen.has(rowKey);
  const toggle = (on: boolean) => setBreakOpen((current) => { const next = new Set(current); if (on) next.add(rowKey); else next.delete(rowKey); return next; });
  return (
    <div className="sf-hours__extras">
      {row.closed ? null : open ? (
        <span className="sf-hours__break" role="group" aria-label={`Break on ${name}`}>
          <label><span>Break from</span><input id={`${base}-from`} type="time" value={row.break_starts} aria-label={`${name} break from`}
            onChange={(event) => onChange({ break_starts: event.target.value })} /></label>
          <label><span>until</span><input type="time" value={row.break_ends} aria-label={`${name} break until`}
            onChange={(event) => onChange({ break_ends: event.target.value })} /></label>
          {!disabled && <button type="button" className="btn btn--ghost btn--sm" onClick={() => { toggle(false); onChange({ ...withoutBreak }); }}>Remove break</button>}
        </span>
      ) : !disabled && (
        <button type="button" className="btn btn--ghost btn--sm" aria-label={`Add break on ${name}`}
          onClick={() => { toggle(true); window.setTimeout(() => document.getElementById(`${base}-from`)?.focus(), 0); }}>
          <Plus size={14} aria-hidden="true" /> Add break
        </button>
      )}
      {commentPlaceholder !== undefined && (
        <label className="sf-hours__comment"><span>Comment</span><input value={row.note} maxLength={200} placeholder={commentPlaceholder}
          aria-label={`Comment for ${name}`} onChange={(event) => onChange({ note: event.target.value })} /></label>
      )}
    </div>
  );
}

const EXCEPTION_DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const exceptionDayLabel = (date: string) => { const [y, m, d] = date.split('-').map(Number); return EXCEPTION_DAY.format(new Date(Date.UTC(y!, m! - 1, d!, 12))); };
const todayIn = (timeZone: string | undefined, at = new Date()) => {
  try { return localDate(at, timeZone ?? siteTimeZone(undefined)).date; } catch { return localDate(at).date; }
};

function OpeningHoursInput({ siteId, timeZone, today, field, value, disabled, problems, onChange }: {
  siteId: string; timeZone?: string; today: string | null;
  field: FieldDefinition; value: unknown; disabled: boolean; problems: ValueProblem[]; onChange: (value: unknown) => void;
}) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const days = openingHoursRows(value);
  const exceptions = exceptionRows(value);
  const own = problems.filter((problem) => !problem.path);
  const rowProblems = (prefix: string) => problemsUnder(problems, prefix).map((problem) => problem.message);
  const weekdays = WEEKDAYS.slice(0, 5) as readonly Weekday[];
  const order = exceptionOrder(value);
  const duplicates = duplicateExceptionDates(value);
  const pastCount = today ? exceptions.filter((row) => isPastDate(row.date, today)).length : 0;
  const focusNew = useRef<string | null>(null);
  const [breakOpen, setBreakOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!focusNew.current) return;
    document.getElementById(focusNew.current)?.focus();
    focusNew.current = null;
  });
  return (
    <fieldset className="sf-hours" disabled={disabled}>
      <legend className="sf-label"><Clock size={14} aria-hidden="true" /> {field.label}{field.required && <span aria-hidden="true"> *</span>}</legend>
      {field.help && <p className="sf-muted sf-small">{field.help}</p>}
      {own.length > 0 && <ul className="sf-errors" role="alert">{own.map((problem) => <li key={problem.message}>{problem.message}</li>)}</ul>}
      <TimeZoneNote siteId={siteId} zone={timeZone ?? siteTimeZone(undefined)} className="sf-muted" />
      <table className="sf-hours__week">
        <caption className="sf-sr">Weekly hours</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Closed</th><th scope="col">Opens</th><th scope="col">Closes</th></tr></thead>
        <tbody>
          {days.map((row, index) => {
            const label = WEEKDAY_LABELS[row.day];
            const messages = [...rowProblems(`days[${index}]`), ...(timeProblem(row) ? [timeProblem(row)!] : []), ...(breakProblem(row) ? [breakProblem(row)!] : [])];
            return (
              <Fragment key={row.day}>
              <tr className={messages.length ? 'is-error' : ''}>
                <th scope="row">{label}</th>
                <td data-label="Closed"><input type="checkbox" aria-label={`${label} closed`} checked={row.closed}
                  onChange={(event) => onChange(setDay(value, row.day, { closed: event.target.checked }))} /></td>
                <td data-label="Opens"><input type="time" aria-label={`${label} opens`} value={row.opens} disabled={row.closed}
                  onChange={(event) => onChange(setDay(value, row.day, { opens: event.target.value }))} /></td>
                <td data-label="Closes"><input type="time" aria-label={`${label} closes`} value={row.closes} disabled={row.closed}
                  onChange={(event) => onChange(setDay(value, row.day, { closes: event.target.value }))} /></td>
              </tr>
              <tr className="sf-hours__extra-row"><td colSpan={4} className="sf-hours__extra">
                <RowExtras rowKey={row.day} name={label} row={row} disabled={disabled} breakOpen={breakOpen} setBreakOpen={setBreakOpen}
                  commentPlaceholder="Lunch closed 12–13" onChange={(patch) => onChange(setDay(value, row.day, patch))} />
              </td></tr>
              {messages.length > 0 && <tr className="sf-hours__note-row"><td className="sf-hours__note" colSpan={4} role="alert">{label}: {messages.join(' · ')}</td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {!disabled && (
        <p className="sf-row">
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => onChange(copyDay(value, 'monday', weekdays.slice(1)))}>Copy Monday to Tuesday–Friday</button>
        </p>
      )}
      <p className="sf-muted sf-small">A day without both times shows as closed. A break is a closed period inside the day, such as lunch.</p>
      <div className="sf-input">
        <label htmlFor={`${base}-note`}>Comment under the hours</label>
        <textarea id={`${base}-note`} rows={2} maxLength={500} value={hoursNote(value)} placeholder="Lunch closed 12–13 on weekdays"
          onChange={(event) => onChange(setHoursNote(value, event.target.value))} />
        <small className="sf-muted">Shown to visitors under the opening hours.</small>
      </div>

      <h3 className="sf-label" id={`${base}-exceptions`}>Deviating hours on a date</h3>
      <p className="sf-muted sf-small">
        Holidays and other single dates with different hours, entered in advance. A date wins over its weekday.
        The comment is shown in bold under the weekday name when that date is in the week shown.
      </p>
      {exceptions.length === 0 && <p className="sf-muted sf-small">No dates with deviating hours.</p>}
      <ol className="sf-hours__exceptions" aria-labelledby={`${base}-exceptions`}>
        {order.map((index, position) => {
          const row = exceptions[index]!;
          const name = row.date || `new date ${position + 1}`;
          const past = today ? isPastDate(row.date, today) : false;
          const twice = !!row.date && duplicates.has(row.date);
          const messages = [
            ...rowProblems(`exceptions[${index}]`),
            ...(timeProblem(row) ? [timeProblem(row)!] : []),
            ...(breakProblem(row) ? [breakProblem(row)!] : []),
            ...(twice ? [`Two exceptions on ${row.date}: keep one`] : []),
            ...(!row.date ? ['Pick a date'] : []),
          ];
          const id = `${base}-ex-${index}`;
          return (
            <li key={index} className={`${messages.length ? 'is-error' : ''}${past ? ' is-past' : ''}`.trim() || undefined}>
              <label><span>Date{past ? ' (past)' : ''}</span><input id={`${id}-date`} type="date" required value={row.date} aria-label={`Date of ${name}`}
                aria-invalid={twice || !row.date || undefined}
                onChange={(event) => onChange(updateException(value, index, { date: event.target.value }))} /></label>
              {row.date && <span className="sf-hours__weekday">{exceptionDayLabel(row.date)}</span>}
              <label className="sf-check"><input type="checkbox" checked={row.closed} aria-label={`Closed on ${name}`}
                onChange={(event) => onChange(updateException(value, index, { closed: event.target.checked }))} /> Closed</label>
              <label><span>Opens</span><input type="time" value={row.opens} disabled={row.closed} aria-label={`Opens on ${name}`}
                onChange={(event) => onChange(updateException(value, index, { opens: event.target.value }))} /></label>
              <label><span>Closes</span><input type="time" value={row.closes} disabled={row.closed} aria-label={`Closes on ${name}`}
                onChange={(event) => onChange(updateException(value, index, { closes: event.target.value }))} /></label>
              <label className="sf-hours__note-input"><span>Comment shown to visitors</span><input value={row.note} maxLength={200} placeholder="Christmas Eve"
                aria-label={`Comment shown to visitors on ${name}`}
                onChange={(event) => onChange(updateException(value, index, { note: event.target.value }))} /></label>
              {!disabled && <button type="button" className="sf-iconbtn" aria-label={`Remove ${name}`} title="Remove" onClick={() => onChange(removeException(value, index))}><Trash2 size={15} aria-hidden="true" /></button>}
              <div className="sf-hours__exception-break">
                <RowExtras rowKey={`ex-${index}`} name={name} row={row} disabled={disabled} breakOpen={breakOpen} setBreakOpen={setBreakOpen}
                  onChange={(patch) => onChange(updateException(value, index, patch))} />
              </div>
              {messages.length > 0 && <p className="sf-error sf-small" role="alert">{messages.join(' · ')}</p>}
            </li>
          );
        })}
      </ol>
      {!disabled && (
        <p className="sf-row">
          <button type="button" className="btn btn--secondary btn--sm" disabled={exceptions.length >= MAX_EXCEPTIONS}
            onClick={() => { onChange(addUpcomingException(value, today ?? todayIn(timeZone))); focusNew.current = `${base}-ex-${exceptions.length}-date`; }}>
            <Plus size={14} aria-hidden="true" /> Add date
          </button>
          {pastCount > 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(removePastExceptions(value, today!))}>
              Remove past dates ({pastCount})
            </button>
          )}
        </p>
      )}
    </fieldset>
  );
}

/** A control under its label; the notes after the control stay outside the label. */
function Labeled({ label, id, children }: { label: string; id?: string; children: (id: string) => React.ReactNode }) {
  const auto = useId();
  const controlId = id ?? auto;
  return <div className="sf-input"><label htmlFor={controlId}>{label}</label>{children(controlId)}</div>;
}

function UsageHint({ field }: { field: FieldDefinition }) {
  const usage = fieldUsage(field);
  return (
    <div className="sf-usage">
      <code>{usage.placeholder}</code>
      <CopyButton text={usage.placeholder} label={`Copy the placeholder for ${field.label}`} />
      {usage.condition && <><span className="sf-muted">condition</span> <code>{usage.condition}</code></>}
      <span className="sf-muted">{usage.hint}</span>
    </div>
  );
}

/** Copy to the clipboard; without the Clipboard API, through a selected text area. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <>
      <button type="button" className="sf-iconbtn" aria-label={label} title="Copy"
        onClick={async () => { setState((await copyText(text)) ? 'copied' : 'failed'); window.setTimeout(() => setState('idle'), 2000); }}>
        {state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <span className="sf-sr" aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copying failed: select the text and copy it' : ''}</span>
      {state === 'failed' && <span className="sf-error sf-small">Select the text and copy it.</span>}
    </>
  );
}

// ─── Definitions ────────────────────────────────────────────────────────

export interface DefinitionContext {
  domId: string;
  groups: SiteFieldGroup[];
  groupIndex: number;
  savedNames: Set<string>;
  savedGroupIds: Set<string>;
  values: Record<string, unknown>;
  errors: DefinitionErrors;
  open: Set<string>;
  setOpen: React.Dispatch<React.SetStateAction<Set<string>>>;
  pendingFocus: React.MutableRefObject<string | null>;
  onChange: (groups: SiteFieldGroup[]) => void;
}

/** One settings page in define mode: its title, id, access and fields. Exported for tests. */
export function GroupDefinition(props: DefinitionContext & { onRemove: () => void; onMove: (delta: -1 | 1) => void }) {
  const { domId, groups, groupIndex, values, errors, onChange, onRemove, onMove, setOpen, pendingFocus } = props;
  const group = groups[groupIndex]!;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const problems = errors.byKey.get(definitionKey(groupIndex)) ?? [];
  const problemOf = (property: string) => problems.filter((problem) => problem.property === property).map((problem) => problem.message);
  const otherIds = groups.filter((_, i) => i !== groupIndex).map((g) => g.id);
  const idProblem = groupIdProblem(group.id, otherIds);
  const withValues = group.fields.filter((field) => values[field.name] !== undefined).length;
  const set = (patch: Partial<Omit<SiteFieldGroup, 'fields'>>) => onChange(updateGroup(groups, groupIndex, patch));
  const setFields = (fields: FieldDefinition[]) => onChange(groups.map((g, i) => (i === groupIndex ? { ...g, fields } : g)));
  const totalFields = countSiteFields(groups);

  function add(kind: 'field' | 'hours') {
    const result = kind === 'hours' ? addOpeningHours(groups, groupIndex) : addFieldTo(groups, groupIndex, []);
    onChange(result.groups);
    const key = definitionKey(groupIndex, result.path);
    setOpen((current) => new Set(current).add(key));
    pendingFocus.current = `${domId}-${key}-label`;
  }

  return (
    <section className="sf-card sf-panel" aria-label={`Settings page ${group.label || group.id}`}>
      <div className="sf-define-grid">
        <Labeled label="Title" id={`${domId}-group-label`}>{() => <>
          <input id={`${domId}-group-label`} value={group.label} maxLength={120} aria-invalid={!group.label.trim()}
            onChange={(event) => {
              const label = event.target.value;
              // A page that is not saved yet takes its id from the title.
              const follows = !props.savedGroupIds.has(group.id) && group.id === suggestGroupId(group.label, otherIds);
              set({ label, ...(follows && label.trim() ? { id: suggestGroupId(label, otherIds) } : {}) });
            }} />
          {[...problemOf('label'), ...(!group.label.trim() ? ['Give the settings page a title'] : [])].slice(0, 1).map((message) => <small key={message} className="sf-error">{message}</small>)}
        </>}</Labeled>
        <Labeled label="Id">{(id) => <>
          <input id={id} value={group.id} spellCheck={false} maxLength={64} aria-invalid={!!idProblem} onChange={(event) => set({ id: event.target.value })} />
          {(idProblem || problemOf('id')[0]) ? <small className="sf-error">{idProblem ?? problemOf('id')[0]}</small> : <small className="sf-muted">Names the page in the API and the address.</small>}
        </>}</Labeled>
        <Labeled label="Who changes the values">{(id) => <>
          <select id={id} value={group.access ?? 'editor'} onChange={(event) => set({ access: event.target.value as 'editor' | 'admin' })}>
            <option value="editor">Editors and administrators</option>
            <option value="admin">Administrators only</option>
          </select>
        </>}</Labeled>
      </div>
      <Labeled label="Description (optional)">{(id) => <>
        <input id={id} value={group.description ?? ''} maxLength={300} placeholder="What editors find here" onChange={(event) => set({ description: event.target.value })} />
      </>}</Labeled>
      {problems.filter((problem) => !['label', 'id'].includes(problem.property)).map((problem) => <p key={problem.message} className="sf-error">{problem.message}</p>)}

      <div className="sf-section-head">
        <h2>Fields</h2>
        <span className="sf-muted sf-small">{totalFields} of at most {MAX_SITE_FIELDS} on the site</span>
      </div>
      {group.fields.length === 0 && <p className="sf-muted">No fields yet. Add a field, or opening hours with a week and exceptions ready.</p>}
      <FieldList {...props} fields={group.fields} parent={[]} depth={1} setFields={setFields} />
      <p className="sf-row">
        <button type="button" className="btn btn--secondary btn--sm" disabled={!canAddField(groups, [])} onClick={() => add('field')}><Plus size={14} aria-hidden="true" /> Add field</button>
        <button type="button" className="btn btn--secondary btn--sm" disabled={!canAddField(groups, [])} onClick={() => add('hours')}><Clock size={14} aria-hidden="true" /> Add opening hours</button>
      </p>

      <div className="sf-define-footer">
        <span className="sf-row">
          <button type="button" className="btn btn--ghost btn--sm" disabled={groupIndex === 0} onClick={() => onMove(-1)}><ArrowUp size={14} aria-hidden="true" /> Move page earlier</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={groupIndex === groups.length - 1} onClick={() => onMove(1)}><ArrowDown size={14} aria-hidden="true" /> Move page later</button>
        </span>
        {!confirmRemove ? (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirmRemove(true)}><Trash2 size={14} aria-hidden="true" /> Delete settings page…</button>
        ) : (
          <div className="sf-confirm" role="group" aria-label="Confirm deleting the settings page">
            <p>Delete “{group.label || group.id}” and its {group.fields.length === 1 ? 'field' : `${group.fields.length} fields`}?{withValues ? ` Saving deletes ${withValues === 1 ? 'its saved value' : `${withValues} saved values`}.` : ''}</p>
            <span className="sf-row">
              <button type="button" className="btn btn--danger btn--sm" onClick={() => { setConfirmRemove(false); onRemove(); }}>Delete settings page</button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmRemove(false)}>Cancel</button>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function FieldList(props: DefinitionContext & { fields: FieldDefinition[]; parent: FieldPath; depth: number; setFields: (fields: FieldDefinition[]) => void }) {
  const { fields, parent, depth, groupIndex, setOpen, setFields } = props;
  const group = props.groups[groupIndex]!;
  const list = fields;
  return (
    <ol className={`sf-deflist${depth > 1 ? ' sf-deflist--nested' : ''}`}>
      {list.map((field, index) => {
        const path = [...parent, index];
        return (
          <FieldCard key={`${definitionKey(groupIndex, path)}`} {...props} field={field} path={path} depth={depth}
            siblings={list}
            onMove={(delta) => {
              setFields(moveFieldAt(group.fields, path, delta));
              setOpen((current) => reindexKeys(current, groupIndex, parent, (i) => (i === index ? index + delta : i === index + delta ? index : i)));
            }}
            onRemove={() => {
              setFields(removeFieldAt(group.fields, path));
              setOpen((current) => reindexKeys(current, groupIndex, parent, (i) => (i === index ? null : i > index ? i - 1 : i)));
            }} />
        );
      })}
    </ol>
  );
}

function FieldCard(props: DefinitionContext & {
  field: FieldDefinition; path: FieldPath; depth: number; siblings: FieldDefinition[];
  setFields: (fields: FieldDefinition[]) => void; onMove: (delta: -1 | 1) => void; onRemove: () => void;
}) {
  const { domId, groups, groupIndex, field, path, depth, siblings, savedNames, values, errors, open, setOpen, setFields, onMove, onRemove, pendingFocus } = props;
  const group = groups[groupIndex]!;
  const key = definitionKey(groupIndex, path);
  const controlId = `${domId}-${key}`;
  const expanded = open.has(key);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const problems = errors.byKey.get(key) ?? [];
  const problemOf = (property: string) => problems.filter((problem) => problem.property === property).map((problem) => problem.message);
  const topLevel = path.length === 1;
  const taken = topLevel
    ? groups.flatMap((g, gi) => g.fields.filter((_, fi) => !(gi === groupIndex && fi === path[0])).map((f) => f.name))
    : siblings.filter((other) => other !== field).map((other) => other.name);
  const nameProblem = fieldNameProblem(field.name, taken);
  const hours = isOpeningHours(field);
  const isGroup = (field.type === 'array' || field.type === 'object') && !hours;
  const holdsValue = topLevel && savedNames.has(field.name) && values[field.name] !== undefined;
  const set = (patch: Partial<FieldDefinition>) => setFields(updateFieldAt(group.fields, path, patch));
  const toggle = () => setOpen((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  function setLabel(label: string) {
    // A field that is not saved yet takes its name from the label.
    const savedTop = savedNames.has(group.fields[path[0]!]?.name ?? '');
    const derived = !savedTop && field.name === suggestFieldName(field.label, taken);
    set({ label, ...(derived && label.trim() ? { name: suggestFieldName(label, taken) } : {}) });
  }

  function addChild() {
    const children = field.fields ?? [];
    const name = suggestFieldName('New field', children.map((child) => child.name));
    set({ fields: [...children, { name, type: 'text', label: 'New field' }] });
    const childKey = definitionKey(groupIndex, [...path, children.length]);
    setOpen((current) => new Set(current).add(childKey));
    pendingFocus.current = `${domId}-${childKey}-label`;
  }

  const meta = `${field.name} · ${hours ? 'Opening hours' : SITE_FIELD_TYPE_LABELS[field.type] ?? field.type}${field.required ? ' · required' : ''}${topLevel && isLiveField(field) ? ' · live' : ''}`;
  return (
    <li className={`sf-defcard${problems.length ? ' sf-defcard--error' : ''}`}>
      <div className="sf-defcard__head">
        <button type="button" className="sf-defcard__toggle" aria-expanded={expanded} aria-controls={`${controlId}-body`} onClick={toggle}>
          {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          <span className="sf-defcard__text"><span>{field.label || field.name || 'Untitled field'}</span><span className="sf-muted sf-small">{meta}</span></span>
        </button>
        <span className="sf-defcard__actions">
          <button type="button" className="sf-iconbtn" aria-label={`Move ${field.label} up`} title="Move up" disabled={!canMoveField(group.fields, path, -1)} onClick={() => onMove(-1)}><ArrowUp size={15} aria-hidden="true" /></button>
          <button type="button" className="sf-iconbtn" aria-label={`Move ${field.label} down`} title="Move down" disabled={!canMoveField(group.fields, path, 1)} onClick={() => onMove(1)}><ArrowDown size={15} aria-hidden="true" /></button>
          <button type="button" className="sf-iconbtn" aria-label={`Remove ${field.label}`} title="Remove" onClick={() => setConfirmRemove(true)}><Trash2 size={15} aria-hidden="true" /></button>
        </span>
      </div>
      {confirmRemove && (
        <div className="sf-confirm" role="group" aria-label={`Confirm removing ${field.label}`}>
          <p>Remove “{field.label}”?{holdsValue ? ' Its saved value is deleted when you save the fields.' : topLevel ? '' : ' Its values in each item are deleted when you save.'}</p>
          <span className="sf-row">
            <button type="button" className="btn btn--danger btn--sm" onClick={() => { setConfirmRemove(false); onRemove(); }}>Remove field</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmRemove(false)}>Cancel</button>
          </span>
        </div>
      )}
      {!expanded && problems.length > 0 && <p className="sf-error sf-small sf-defcard__summary">{problems[0]!.message}</p>}
      {expanded && (
        <div id={`${controlId}-body`} className="sf-defcard__body">
          <div className="sf-define-grid">
            <Labeled label="Label" id={`${controlId}-label`}>{() => <>
              <input id={`${controlId}-label`} value={field.label} maxLength={120} aria-invalid={!field.label.trim()} onChange={(event) => setLabel(event.target.value)} />
              {problemOf('label').map((message) => <small key={message} className="sf-error">{message}</small>)}
            </>}</Labeled>
            <Labeled label="Name">{(id) => <>
              <input id={id} value={field.name} spellCheck={false} maxLength={64} aria-invalid={!!nameProblem} onChange={(event) => set({ name: event.target.value })} />
              {nameProblem || problemOf('name')[0]
                ? <small className="sf-error">{nameProblem ?? problemOf('name')[0]}</small>
                : <small className="sf-muted">{holdsValue ? 'Renaming deletes the saved value under the old name.' : 'Lowercase letters, digits and _. Used in templates.'}</small>}
            </>}</Labeled>
            {hours ? (
              <div className="sf-input"><span>Type</span><p className="sf-muted sf-small">Opening hours: a week plus dated exceptions, with a ready editor.</p></div>
            ) : (
              <Labeled label="Type">{(id) => <>
                <select id={id} value={field.type} onChange={(event) => set(typeChange(field, event.target.value as FieldType))}>
                  {typesAtDepth(depth).map((type) => <option key={type} value={type}>{SITE_FIELD_TYPE_LABELS[type] ?? type}</option>)}
                </select>
                {problemOf('type').map((message) => <small key={message} className="sf-error">{message}</small>)}
              </>}</Labeled>
            )}
          </div>
          <Labeled label="Help text (optional)">{(id) => <>
            <input id={id} value={field.help ?? ''} maxLength={300} placeholder="Shown with the field" onChange={(event) => set({ help: event.target.value })} />
          </>}</Labeled>
          <label className="sf-check"><input type="checkbox" checked={!!field.required} onChange={(event) => set({ required: event.target.checked || undefined })} /> Required</label>
          {topLevel && (
            <div className="sf-input">
              <label className="sf-check"><input type="checkbox" checked={isLiveField(field)} aria-describedby={`${controlId}-live-help`}
                onChange={(event) => set({ live: event.target.checked || undefined } as Partial<FieldDefinition>)} /> Live (updates without publishing)</label>
              <small id={`${controlId}-live-help`} className="sf-muted">A saved value reaches <strong>Site field</strong> blocks on the site within a minute, without publishing. Use it for values that change often, such as the current delivery time. Placeholders and conditions still follow the publication.</small>
            </div>
          )}
          {['text', 'textarea', 'url', 'email', 'number'].includes(field.type) && (
            <Labeled label="Placeholder (optional)">{(id) => <>
              <input id={id} value={field.placeholder ?? ''} maxLength={120} onChange={(event) => set({ placeholder: event.target.value })} />
            </>}</Labeled>
          )}
          {field.type === 'number' && (
            <div className="sf-define-grid">
              <Labeled label="Lowest (optional)">{(id) => <><input id={id} type="number" value={field.min ?? ''} onChange={(event) => set({ min: event.target.value === '' ? undefined : Number(event.target.value) })} /></>}</Labeled>
              <Labeled label="Highest (optional)">{(id) => <><input id={id} type="number" value={field.max ?? ''} onChange={(event) => set({ max: event.target.value === '' ? undefined : Number(event.target.value) })} /></>}</Labeled>
            </div>
          )}
          {(field.type === 'select' || field.type === 'multiselect') && <OptionsInput field={field} problems={problemOf('options')} onChange={(options, labels) => set({ options, option_labels: labels })} />}
          {field.type === 'array' && !hours && (
            <div className="sf-define-grid">
              <Labeled label="Item title">{(id) => <>
                <select id={id} value={field.item_label ?? ''} onChange={(event) => set({ item_label: event.target.value || undefined })}>
                  <option value="">First text field</option>
                  {(field.fields ?? []).map((child) => <option key={child.name} value={child.name}>{child.label}</option>)}
                </select>
              </>}</Labeled>
              <Labeled label="Fewest items">{(id) => <><input id={id} type="number" min={0} max={500} value={field.min_items ?? ''} onChange={(event) => set({ min_items: event.target.value === '' ? undefined : Number(event.target.value) })} /></>}</Labeled>
              <Labeled label="Most items">{(id) => <><input id={id} type="number" min={0} max={500} value={field.max_items ?? ''} onChange={(event) => set({ max_items: event.target.value === '' ? undefined : Number(event.target.value) })} /></>}</Labeled>
            </div>
          )}
          {isGroup && (
            <div className="sf-subfields">
              <h3 className="sf-label">{field.type === 'array' ? 'Fields of each item' : 'Fields in the group'}</h3>
              {problemOf('fields').map((message) => <p key={message} className="sf-error sf-small">{message}</p>)}
              <FieldList {...props} fields={field.fields ?? []} parent={path} depth={depth + 1} />
              <button type="button" className="btn btn--secondary btn--sm" onClick={addChild}><Plus size={14} aria-hidden="true" /> Add field to {field.type === 'array' ? 'each item' : 'the group'}</button>
            </div>
          )}
          {problems.filter((problem) => !['label', 'name', 'type', 'options', 'fields'].includes(problem.property)).map((problem) => <p key={problem.message} className="sf-error sf-small">{problem.message}</p>)}
          {topLevel && <UsageHint field={field} />}
        </div>
      )}
    </li>
  );
}

function OptionsInput({ field, problems, onChange }: { field: FieldDefinition; problems: string[]; onChange: (options: string[], labels: string[] | undefined) => void }) {
  const id = useId();
  const [text, setText] = useState(() => optionsToText(field));
  return (
    <div className="sf-input">
      <label htmlFor={id}>Options</label>
      <textarea id={id} rows={4} value={text} spellCheck={false} aria-describedby={`${id}-help`}
        onChange={(event) => { setText(event.target.value); const parsed = optionsFromText(event.target.value); onChange(parsed.options, parsed.labels); }} />
      <small id={`${id}-help`} className="sf-muted">One option per line. Write <code>value | Label</code> to show editors a different label from the stored value.</small>
      {problems.map((message) => <small key={message} className="sf-error">{message}</small>)}
    </div>
  );
}

// Dark surface like the page editor and block builder, which the shared field
// inputs are made for. Every text colour keeps at least 4.5:1 against its
// background. Raw text: React would escape the attribute selectors' quotes.
const SITE_FIELDS_CSS = `
.site-fields {
  display: grid; gap: 1rem; min-width: 0; max-width: 1100px; padding: 1.25rem; border-radius: var(--radius-lg);
  background: #0f0f12; color: #e4e4e7; color-scheme: dark;
  --color-text: #fafafa; --color-text-muted: #c4c4cc; --color-border: #3a3a42; --color-surface: #1f1f23; --color-bg: #18181b;
  --color-primary: #4f46e5; --color-primary-hover: #4338ca; --color-danger: #ef4444;
}
.site-fields :where(input:not([type="checkbox"], [type="radio"]), textarea, select) {
  background-color: #1f1f23; color: #fafafa; border: 1px solid #3a3a42; border-radius: 6px; padding: .45rem .6rem; font-size: .9rem; min-width: 0; max-width: 100%;
}
.site-fields :where(input, textarea)::placeholder { color: #a1a1aa; opacity: 1; }
.site-fields :where(input, textarea, select):disabled { opacity: .55; }
.site-fields :where(button, a, input, select, textarea, summary):focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
.site-fields a { color: #a5b4fc; }
.site-fields code { font-family: var(--font-mono); font-size: .82em; background: #27272a; color: #f4f4f5; padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.site-fields .btn--secondary { background: #27272a; color: #f4f4f5; border: 1px solid #52525b; }
.site-fields .btn--secondary:hover { background: #3f3f46; }
.site-fields .btn--ghost { color: #e4e4e7; }
.site-fields .btn--ghost:hover { background: #27272a; }
.site-fields .btn--sm { min-height: 36px; }
.site-fields h1 { font-size: 1.5rem; color: #fafafa; }
.site-fields h2 { font-size: 1.05rem; color: #fafafa; }
.sf-header { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem 1rem; flex-wrap: wrap; }
.sf-header__actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.sf-status { font-size: .875rem; color: #c4c4cc; }
.sf-intro { max-width: 760px; }
.sf-muted { color: #c4c4cc; }
.sf-small { font-size: .82rem; }
.sf-label { display: inline-flex; align-items: center; gap: 6px; font-size: .875rem; font-weight: 600; color: #fafafa; }
.sf-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.sf-card { background: #161618; border: 1px solid #2a2a30; border-radius: 10px; padding: 1rem; min-width: 0; }
.sf-empty { display: grid; gap: .75rem; max-width: 760px; }
.sf-panel { display: grid; gap: 1rem; }
.sf-panel__head { display: flex; justify-content: space-between; align-items: flex-start; gap: .5rem 1rem; flex-wrap: wrap; }
.sf-panel__actions { display: flex; gap: .5rem; flex-wrap: wrap; padding-top: .75rem; border-top: 1px solid #2a2a30; position: sticky; bottom: 0; background: #161618; }
.sf-readonly { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; color: #fcd34d; }
.sf-readonly-value { display: grid; gap: 2px; }
.sf-fields { display: grid; gap: .5rem; }
.sf-field { display: grid; gap: .35rem; padding: .75rem; border: 1px solid #2a2a30; border-radius: 8px; min-width: 0; }
.sf-field--error { border-color: #ef4444; }
.sf-live { display: inline-block; font-size: .72rem; font-weight: 600; padding: 0 8px; border-radius: 999px; border: 1px solid #166534; background: #052e16; color: #bbf7d0; }
.sf-live-note { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; margin: 0; font-size: .78rem; }
.sf-usage { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; font-size: .78rem; }
.sf-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #3a3a42; }
.sf-tabs button { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: .45rem .75rem; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; color: #c4c4cc; font-weight: 500; cursor: pointer; }
.sf-tabs button.is-active { color: #fafafa; border-bottom-color: #818cf8; }
.sf-tabs button:hover:not(:disabled) { color: #fafafa; }
.sf-tabs__add { color: #a5b4fc !important; }
.sf-tabs button:disabled { opacity: .5; cursor: not-allowed; }
.sf-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #fbbf24; }
.sf-notice { display: flex; align-items: center; gap: .5rem; padding: .6rem .85rem; border-radius: 8px; background: #052e16; border: 1px solid #166534; color: #bbf7d0; }
.sf-problem { padding: .75rem 1rem; border-radius: 8px; border: 1px solid #ef4444; background: #2a1215; color: #fecaca; display: grid; gap: .5rem; }
.sf-problem--stale { border-color: #f59e0b; background: #2a1f0b; color: #fde68a; }
.sf-error { color: #fca5a5; }
.sf-errors { margin: 0; padding-left: 1.25rem; color: #fca5a5; font-size: .85rem; }
.sf-check { display: inline-flex; align-items: center; gap: .5rem; min-height: 36px; cursor: pointer; }
.sf-check input { width: 18px; height: 18px; }
.sf-iconbtn { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: none; color: #e4e4e7; cursor: pointer; }
.sf-iconbtn:hover:not(:disabled) { border-color: #52525b; background: #27272a; }
.sf-iconbtn:disabled { color: #71717a; cursor: not-allowed; }
.sf-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.sf-hours { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: .5rem; }
.sf-hours legend { padding: 0; margin-bottom: .35rem; }
.sf-hours__week { border-collapse: collapse; width: 100%; max-width: 560px; }
.sf-hours__week th, .sf-hours__week td { text-align: left; padding: .3rem .5rem .3rem 0; font-size: .875rem; }
.sf-hours__week thead th { color: #c4c4cc; font-weight: 500; font-size: .78rem; }
.sf-hours__week tbody th { font-weight: 500; color: #fafafa; }
.sf-hours__week input[type="time"] { width: 8rem; }
.sf-hours__week input[type="checkbox"] { width: 18px; height: 18px; }
.sf-hours__week tr.is-error th { color: #fca5a5; }
.sf-hours__note { color: #fca5a5; font-size: .8rem; }
.sf-hours__exceptions { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
.sf-hours__exceptions li { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .5rem .75rem; padding: .6rem; border: 1px solid #2a2a30; border-radius: 8px; }
.sf-hours__exceptions li.is-error { border-color: #ef4444; }
.sf-hours__exceptions li.is-past { opacity: .62; border-style: dashed; }
.sf-hours__exceptions li.is-past:focus-within { opacity: 1; }
.sf-hours__week .sf-hours__extra-row td { padding-top: 0; }
.sf-hours__extras { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .35rem .75rem; padding-bottom: .4rem; border-bottom: 1px solid #2a2a30; }
.sf-hours__break { display: inline-flex; flex-wrap: wrap; align-items: flex-end; gap: .35rem .5rem; }
.sf-hours__break label, .sf-hours__comment { display: grid; gap: 2px; font-size: .78rem; color: #c4c4cc; }
.sf-hours__break input[type="time"] { width: 8rem; }
.sf-hours__comment { flex: 1 1 14rem; min-width: 0; }
.sf-hours__exception-break { flex-basis: 100%; }
.sf-hours__exception-break .sf-hours__extras { border-bottom: 0; padding-bottom: 0; }
.sf-hours__weekday { align-self: center; font-size: .82rem; color: #e4e4e7; min-width: 9rem; }
.sf-hours__exceptions label:not(.sf-check) { display: grid; gap: 2px; font-size: .78rem; color: #c4c4cc; }
.sf-hours__exceptions input[type="time"] { width: 8rem; }
.sf-hours__note-input { flex: 1 1 10rem; }
.sf-hours__exceptions p { flex-basis: 100%; margin: 0; }
.sf-input { display: grid; gap: 4px; align-content: start; min-width: 0; font-size: .85rem; }
.sf-input > span, .sf-input > label { color: #e4e4e7; font-weight: 500; }
.sf-input input, .sf-input select, .sf-input textarea { width: 100%; }
.sf-input small { font-size: .78rem; }
.sf-define-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: .75rem; }
.sf-section-head { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; flex-wrap: wrap; padding-top: .5rem; border-top: 1px solid #2a2a30; }
.sf-deflist { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.sf-deflist--nested { margin-left: .25rem; padding-left: .75rem; border-left: 2px solid #3a3a42; }
.sf-defcard { border: 1px solid #3a3a42; border-radius: 8px; background: #18181b; min-width: 0; }
.sf-defcard--error { border-color: #ef4444; }
.sf-defcard__head { display: flex; align-items: center; gap: 2px; padding: 2px 4px; flex-wrap: wrap; }
.sf-defcard__toggle { flex: 1 1 12rem; min-width: 0; display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 4px; border: 0; background: none; color: #fafafa; text-align: left; cursor: pointer; border-radius: 4px; }
.sf-defcard__text { display: grid; min-width: 0; }
.sf-defcard__text > span { overflow-wrap: anywhere; }
.sf-defcard__actions { display: inline-flex; gap: 2px; margin-left: auto; }
.sf-defcard__summary { margin: 0 .75rem .5rem; }
.sf-defcard__body { display: grid; gap: .75rem; padding: .75rem; border-top: 1px solid #3a3a42; }
.sf-subfields { display: grid; gap: .5rem; justify-items: start; }
.sf-subfields > ol { width: 100%; }
.sf-confirm { display: grid; gap: .5rem; padding: .6rem .75rem; margin: 0 .25rem .25rem; border: 1px solid #f59e0b; border-radius: 8px; background: #2a1f0b; color: #fde68a; }
.sf-define-footer { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; flex-wrap: wrap; padding-top: .75rem; border-top: 1px solid #2a2a30; }
@media (max-width: 640px) {
  .site-fields { padding: .85rem; border-radius: 8px; }
  .sf-card { padding: .75rem; }
  .sf-hours__week thead { display: none; }
  .sf-hours__week, .sf-hours__week tbody { display: block; width: 100%; }
  .sf-hours__week tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .35rem .5rem; padding: .5rem 0; border-top: 1px solid #2a2a30; }
  .sf-hours__week tr.sf-hours__note-row, .sf-hours__week tr.sf-hours__extra-row { border-top: 0; padding-top: 0; }
  .sf-hours__week td.sf-hours__extra { grid-column: 1 / -1; }
  .sf-hours__break { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .sf-hours__break input[type="time"] { width: 100%; min-height: 40px; }
  .sf-hours__break .btn { grid-column: 1 / -1; justify-self: start; }
  .sf-hours__week th, .sf-hours__week td { padding: 0; min-width: 0; }
  .sf-hours__week tbody th, .sf-hours__week td[data-label="Closed"], .sf-hours__note { grid-column: 1 / -1; }
  .sf-hours__week td[data-label="Closed"] { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: #c4c4cc; }
  .sf-hours__week td[data-label="Closed"]::before { content: "Closed"; order: 2; }
  .sf-hours__week td[data-label="Opens"], .sf-hours__week td[data-label="Closes"] { display: grid; gap: 2px; font-size: .78rem; color: #c4c4cc; }
  .sf-hours__week td[data-label="Opens"]::before, .sf-hours__week td[data-label="Closes"]::before { content: attr(data-label); }
  .sf-hours__week input[type="time"], .sf-hours__exceptions input:not([type="checkbox"]) { width: 100%; min-width: 0; min-height: 40px; }
  .sf-hours__exceptions li { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; }
  .sf-hours__exceptions label:not(.sf-check) { min-width: 0; }
  .sf-hours__note-input, .sf-hours__exceptions li > label:first-child { grid-column: 1 / -1; }
  .sf-hours__exceptions .sf-iconbtn { justify-self: end; grid-column: 2; }
  .sf-hours__exceptions p { grid-column: 1 / -1; }
  .sf-iconbtn { width: 44px; height: 44px; }
  .sf-panel__actions .btn { flex: 1 1 auto; justify-content: center; }
}
`;
