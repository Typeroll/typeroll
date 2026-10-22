import { useRef, useState, type FormEvent } from 'react';
import type { AiSettingsSummary } from '../lib/ai/organization-ai';
import './OrganizationAiSettings.css';

interface Props {
  organizationName: string;
  initial: AiSettingsSummary;
}

type Feedback = { message: string; error: boolean } | null;

const API = '/api/orgs/ai';

async function request(path: string, method: string, body?: unknown): Promise<AiSettingsSummary> {
  const response = await fetch(`${API}${path}`, {
    method, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The AI settings could not be changed. Try again.');
  return data as AiSettingsSummary;
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function OrganizationAiSettings({ organizationName, initial }: Props) {
  const [settings, setSettings] = useState<AiSettingsSummary>(initial);
  const [busy, setBusy] = useState<'key' | 'remove' | 'access' | null>(null);
  const [keyFeedback, setKeyFeedback] = useState<Feedback>(null);
  const [accessFeedback, setAccessFeedback] = useState<Feedback>(null);
  const [mode, setMode] = useState<'all' | 'selected'>(initial.site_access.mode);
  const [selected, setSelected] = useState<string[]>(initial.site_access.site_ids);
  const keyInput = useRef<HTMLInputElement>(null);
  const keyFeedbackRef = useRef<HTMLParagraphElement>(null);
  const accessFeedbackRef = useRef<HTMLParagraphElement>(null);

  function adopt(next: AiSettingsSummary) {
    setSettings(next);
    setMode(next.site_access.mode);
    setSelected(next.site_access.site_ids);
  }

  function announce(target: 'key' | 'access', feedback: Feedback) {
    (target === 'key' ? setKeyFeedback : setAccessFeedback)(feedback);
    // Move focus to the result so keyboard and screen reader users hear it.
    requestAnimationFrame(() => (target === 'key' ? keyFeedbackRef : accessFeedbackRef).current?.focus());
  }

  async function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = keyInput.current;
    const apiKey = input?.value.trim() ?? '';
    if (!apiKey) {
      announce('key', { message: 'Enter an Anthropic API key.', error: true });
      input?.focus();
      return;
    }
    setBusy('key');
    try {
      const wasConfigured = settings.configured;
      adopt(await request('/key', 'PUT', { api_key: apiKey }));
      if (input) input.value = '';
      announce('key', { error: false, message: wasConfigured
        ? 'The new key was verified with Anthropic and saved. Site access is unchanged.'
        : 'The key was verified with Anthropic and saved. No sites use it yet: choose them below.' });
    } catch (error) {
      announce('key', { message: error instanceof Error ? error.message : String(error), error: true });
    } finally { setBusy(null); }
  }

  async function removeKey() {
    if (!window.confirm('Remove the Anthropic API key? The AI assistant turns off on every site of this organization.')) return;
    setBusy('remove');
    try {
      adopt(await request('/key', 'DELETE'));
      announce('key', { error: false, message: 'The key was removed. The AI assistant is off on every site.' });
    } catch (error) {
      announce('key', { message: error instanceof Error ? error.message : String(error), error: true });
    } finally { setBusy(null); }
  }

  async function saveAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('access');
    try {
      const next = await request('/site-access', 'PUT', mode === 'all' ? { mode } : { mode, site_ids: selected });
      adopt(next);
      const count = next.sites.filter((site) => site.ai_enabled).length;
      announce('access', { error: false, message: next.site_access.mode === 'all'
        ? 'Site access saved. Every site, including new ones, has the AI assistant.'
        : `Site access saved. ${count === 0 ? 'No sites have' : count === 1 ? '1 site has' : `${count} sites have`} the AI assistant.` });
    } catch (error) {
      announce('access', { message: error instanceof Error ? error.message : String(error), error: true });
    } finally { setBusy(null); }
  }

  const toggle = (siteId: string, checked: boolean) =>
    setSelected((current) => checked ? [...new Set([...current, siteId])] : current.filter((id) => id !== siteId));
  const key = settings.key;

  return (
    <div className="org-ai stack">
      <section className="card stack" aria-labelledby="org-ai-key-title">
        <h2 id="org-ai-key-title">Anthropic API key</h2>
        <p className="muted">
          The AI assistant in the portal uses {organizationName}’s own Anthropic API key. Typeroll has no shared key:
          usage is billed to your Anthropic account. Create a key in the{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console<span className="org-ai__visually-hidden"> (opens in a new tab)</span></a>.
        </p>
        <div className="org-ai__status" role="group" aria-label="Key status">
          {key ? (
            <>
              <p><strong>Verified key ending in {key.last4}</strong></p>
              <p className="muted text-sm">
                Checked with Anthropic {formatDate(key.verified_at)}
                {key.set_by_email || key.set_by ? ` · Set by ${key.set_by_email || key.set_by}` : ''}
                {key.set_at ? ` on ${formatDate(key.set_at)}` : ''}
              </p>
            </>
          ) : (
            <p><strong>No key.</strong> The AI assistant is off on every site.</p>
          )}
        </div>
        {!settings.encryption_available ? (
          <p role="alert">This server cannot store secrets yet. Ask the server operator to configure encrypted secret storage (INTEGRATIONS_SECRET_KEY).</p>
        ) : (
          <form className="stack" onSubmit={(event) => void saveKey(event)} autoComplete="off" noValidate>
            <div className="field">
              <label htmlFor="org-ai-key">{key ? 'Replace with a new key' : 'API key'}</label>
              <input
                ref={keyInput}
                id="org-ai-key"
                name="api_key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                maxLength={512}
                aria-describedby="org-ai-key-help"
                aria-invalid={keyFeedback?.error ? true : undefined}
                defaultValue=""
              />
              <p id="org-ai-key-help" className="muted text-sm">
                The key is checked with Anthropic before it is saved, then stored encrypted. Only its last four characters are shown again.
              </p>
            </div>
            <div className="org-ai__actions">
              <button type="submit" className="btn" disabled={busy !== null}>{busy === 'key' ? 'Verifying with Anthropic…' : 'Verify and save key'}</button>
              {key && <button type="button" className="btn btn--secondary" disabled={busy !== null} onClick={() => void removeKey()}>{busy === 'remove' ? 'Removing…' : 'Remove key'}</button>}
            </div>
          </form>
        )}
        {keyFeedback && (
          <p ref={keyFeedbackRef} tabIndex={-1} role={keyFeedback.error ? 'alert' : 'status'} className={keyFeedback.error ? 'org-ai__error' : 'org-ai__success'}>
            {keyFeedback.message}
          </p>
        )}
      </section>

      <section className="card stack" aria-labelledby="org-ai-sites-title">
        <h2 id="org-ai-sites-title">Sites that can use the AI assistant</h2>
        <p className="muted">
          Editors see the AI chat only on the sites you choose here. A new key starts with no sites selected.
          On other sites the chat is hidden, but editors can still change content with their own AI agent, such as
          Claude Code, ChatGPT or Codex, through <a href="/app/settings/ai-connections">AI connections</a> (MCP).
        </p>
        {!key ? (
          <p>Add a key above to choose sites.</p>
        ) : (
          <form className="stack" onSubmit={(event) => void saveAccess(event)}>
            <fieldset className="org-ai__fieldset">
              <legend className="org-ai__visually-hidden">Site access</legend>
              <label className="org-ai__choice">
                <input type="radio" name="org-ai-mode" value="all" checked={mode === 'all'} onChange={() => setMode('all')} />
                <span>All sites, including sites created later</span>
              </label>
              <label className="org-ai__choice">
                <input type="radio" name="org-ai-mode" value="selected" checked={mode === 'selected'} onChange={() => setMode('selected')} />
                <span>Only selected sites</span>
              </label>
            </fieldset>
            {mode === 'selected' && (
              settings.sites.length === 0 ? <p className="muted">This organization has no sites yet.</p> : (
                <fieldset className="org-ai__fieldset">
                  <legend>Selected sites</legend>
                  <ul className="org-ai__sites">
                    {settings.sites.map((site) => (
                      <li key={site.id}>
                        <label className="org-ai__choice">
                          <input type="checkbox" value={site.id} checked={selected.includes(site.id)} onChange={(event) => toggle(site.id, event.currentTarget.checked)} />
                          <span>{site.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )
            )}
            <div className="org-ai__actions">
              <button type="submit" className="btn" disabled={busy !== null}>{busy === 'access' ? 'Saving…' : 'Save site access'}</button>
            </div>
          </form>
        )}
        {accessFeedback && (
          <p ref={accessFeedbackRef} tabIndex={-1} role={accessFeedback.error ? 'alert' : 'status'} className={accessFeedback.error ? 'org-ai__error' : 'org-ai__success'}>
            {accessFeedback.message}
          </p>
        )}
      </section>
    </div>
  );
}
