// The site's live snippets: a list with who changed each last and whether it
// updates live, a form for a new snippet, and an explanation when there are
// none yet.

import { useEffect, useId, useState } from 'react';
import { Info, Plus, Radio } from 'lucide-react';
import { MAX_SNIPPETS, type Snippet, type SnippetError, type SnippetKind } from '@typeroll/shared';
import { KIND_LABELS, describeUpdated, liveSupported, newSnippet, suggestSnippetId } from './snippet-model';
import { SNIPPETS_CSS } from './snippet-styles';

export interface LiveSupport { supported?: boolean; base_url?: string | null; reason?: string }

interface Props {
  siteId: string;
  canEdit: boolean;
  /** Server-loaded list; without it the page loads it itself. */
  initial?: { snippets: Snippet[]; live: LiveSupport } | null;
}

const KIND_HELP: Record<SnippetKind, string> = {
  text: 'Plain text, such as a short notice or a price.',
  html: 'Formatted text with headings, lists and links.',
  dated: 'Different content per weekday or date, such as a lunch menu.',
};

/** The message when live updating is off for the site. */
export function liveNotice(live: LiveSupport | null | undefined): string | null {
  if (!live || liveSupported(live)) return null;
  const reason = live.reason ? `${live.reason.replace(/\.?\s*$/, '.')} ` : '';
  return `Snippets don't update live on this site. ${reason}Saved snippets show on the site at the next publication.`;
}

export default function SnippetList({ siteId, canEdit, initial }: Props) {
  const api = `/api/sites/${encodeURIComponent(siteId)}/snippets`;
  const base = `/app/sites/${encodeURIComponent(siteId)}/snippets`;
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [data, setData] = useState(initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SnippetKind>('dated');
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetch(api)
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { snippets?: Snippet[]; live?: LiveSupport; error?: string };
        if (cancelled) return;
        if (!response.ok || !Array.isArray(body.snippets)) setLoadError(body.error ?? `Loading failed (${response.status})`);
        else setData({ snippets: body.snippets, live: body.live ?? { supported: true } });
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Loading failed'); });
    return () => { cancelled = true; };
  }, [api, initial]);

  const snippets = [...(data?.snippets ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const atLimit = snippets.length >= MAX_SNIPPETS;
  const notice = liveNotice(data?.live);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!name.trim() || atLimit) return;
    setCreating(true);
    setCreateErrors([]);
    const id = suggestSnippetId(name, snippets.map((snippet) => snippet.id));
    try {
      const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newSnippet(id, name, kind)) });
      const body = await response.json().catch(() => ({})) as { snippet?: Snippet; error?: string; errors?: SnippetError[] };
      if (!response.ok) {
        setCreateErrors(body.errors?.length ? body.errors.map((error) => error.message) : [body.error ?? `Creating failed (${response.status})`]);
        setCreating(false);
        return;
      }
      window.location.href = `${base}/${encodeURIComponent(body.snippet?.id ?? id)}`;
    } catch (error) {
      setCreateErrors([error instanceof Error ? error.message : 'Creating failed']);
      setCreating(false);
    }
  }

  return (
    <div className="snippets">
      <div className="sn-header">
        <div className="sn-header__text">
          <h1>Snippets</h1>
          <p className="sn-muted">
            Small pieces of content you change often, such as today's lunch or a notice. A saved snippet shows on the site within a
            minute, without publishing.
          </p>
        </div>
      </div>

      {notice && <p className="sn-notice sn-notice--warn" role="status"><Info size={16} aria-hidden="true" /> {notice}</p>}

      {canEdit && (
        <form className="sn-card sn-create" onSubmit={create} noValidate aria-labelledby={`${domId}-new`}>
          <h2 id={`${domId}-new`}>New snippet</h2>
          <fieldset className="sn-kinds">
            <legend>Kind</legend>
            {(['text', 'html', 'dated'] as const).map((value) => (
              <label key={value} className="sn-kind">
                <input type="radio" name={`${domId}-kind`} value={value} checked={kind === value} onChange={() => setKind(value)} />
                <strong>{KIND_LABELS[value]}</strong>
                <span>{KIND_HELP[value]}</span>
              </label>
            ))}
          </fieldset>
          <div className="sn-create__row">
            <div className="sn-field">
              <label htmlFor={`${domId}-name`}>Name</label>
              <input id={`${domId}-name`} value={name} maxLength={120} placeholder="Lunch menu" aria-invalid={touched && !name.trim()}
                aria-describedby={touched && !name.trim() ? `${domId}-name-error` : undefined} onChange={(event) => setName(event.target.value)} />
            </div>
            <button type="submit" className="btn" disabled={creating || atLimit}><Plus size={16} aria-hidden="true" /> {creating ? 'Creating…' : 'New snippet'}</button>
          </div>
          {touched && !name.trim() && <p id={`${domId}-name-error`} className="sn-error">Give the snippet a name</p>}
          {name.trim() && <p className="sn-muted sn-small">Its id will be <code>{suggestSnippetId(name, snippets.map((snippet) => snippet.id))}</code>.</p>}
          {atLimit && <p className="sn-error">A site has at most {MAX_SNIPPETS} snippets.</p>}
          {createErrors.length > 0 && <ul className="sn-errors" role="alert">{createErrors.map((message) => <li key={message}>{message}</li>)}</ul>}
        </form>
      )}

      {loadError ? <p className="sn-problem" role="alert">Couldn't load the snippets: {loadError}</p>
        : !data ? <p className="sn-muted">Loading the snippets…</p>
        : snippets.length === 0 ? (
          <div className="sn-card sn-card--empty">
            <h2>No snippets yet</h2>
            <p>
              A snippet is content you keep apart from the pages: write it once, show it with a <strong>Snippet</strong> block wherever it
              belongs, and change it here whenever you need to. Visitors see the change within a minute, without a new publication.
            </p>
            <div className="sn-example">
              <strong>Example: today's lunch</strong>
              <span className="sn-muted sn-small">
                Create a <strong>By day/date</strong> snippet, write the week's dishes under Monday to Friday, add a special menu on a
                holiday date and a fallback such as “Closed today”. Each visitor sees the dish for today.
              </span>
            </div>
            {!canEdit && <p className="sn-muted">Creating snippets needs write access to the site.</p>}
          </div>
        ) : (
          <div className="sn-card" style={{ padding: 0 }}>
            <table className="sn-table">
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Last updated</th><th scope="col">On the site</th></tr>
              </thead>
              <tbody>
                {snippets.map((snippet) => (
                  <tr key={snippet.id}>
                    <td className="sn-table__name">
                      <a href={`${base}/${encodeURIComponent(snippet.id)}`}>{snippet.name || snippet.id}</a>
                      <div className="sn-muted sn-small"><code>{snippet.id}</code></div>
                    </td>
                    <td data-label="Kind">{KIND_LABELS[snippet.kind] ?? snippet.kind}</td>
                    <td data-label="Last updated" className="sn-muted sn-small">{describeUpdated(snippet)}</td>
                    <td data-label="On the site">
                      {liveSupported(data.live)
                        ? <span className="sn-badge sn-badge--live"><Radio size={12} aria-hidden="true" /> Live</span>
                        : <span className="sn-badge sn-badge--later">At the next publication</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <style dangerouslySetInnerHTML={{ __html: SNIPPETS_CSS }} />
    </div>
  );
}
