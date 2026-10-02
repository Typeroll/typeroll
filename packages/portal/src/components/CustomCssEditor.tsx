import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { checkCustomCss } from '@typeroll/shared';

/**
 * Managed custom CSS: a code field with line numbers, live syntax checks and
 * warnings for selectors that target platform markup. `onValid` receives the
 * text whenever it has no errors (page CSS autosaves through it); `onSave`
 * adds an explicit Save button (site CSS).
 */
export default function CustomCssEditor({
  id, label, value, onValid, onText, onSave, classHints = [], help, theme = 'dark', ignoreCodes = [], extraProblems = [], placeholder,
}: {
  id?: string;
  label: string;
  value: string;
  onValid?: (css: string) => void;
  /** Receives every edit, valid or not (the caller validates before saving). */
  onText?: (css: string) => void;
  /** Check codes that do not apply here, e.g. `platform_selector` for a block's own scoped CSS. */
  ignoreCodes?: string[];
  /** Problems found elsewhere (the block type validator), shown with the live check's. */
  extraProblems?: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
  placeholder?: string;
  /** Saves the CSS; the live check already shows the warnings the server returns. */
  onSave?: (css: string) => Promise<unknown>;
  /** Classes worth targeting, shown as insertable hints (named styles, block classes). `selector` overrides `.className`. */
  classHints?: Array<{ className: string; label: string; selector?: string }>;
  help?: React.ReactNode;
  theme?: 'dark' | 'light';
}) {
  const fallbackId = useId();
  const fieldId = id ?? fallbackId;
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(value);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  useEffect(() => { if (value !== text) setText(value); setSaved(value); }, [value]);
  const ignoredKey = ignoreCodes.join(',');
  const extraKey = JSON.stringify(extraProblems);
  const problems = useMemo(() => {
    const own = checkCustomCss(text).filter(problem => !ignoreCodes.includes(problem.code));
    const seen = new Set(own.map(problem => problem.message));
    return [...own, ...extraProblems.filter(problem => !seen.has(problem.message)).map(problem => ({ ...problem, line: problem.line ?? 1 }))];
  }, [text, ignoredKey, extraKey]);
  const errors = problems.filter(problem => problem.severity === 'error');
  const lines = text.split('\n').length;

  function change(next: string) {
    setText(next);
    setStatus(null);
    onText?.(next);
    if (onValid && !checkCustomCss(next).some(problem => problem.severity === 'error')) onValid(next);
  }

  async function save() {
    if (!onSave || errors.length || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      await onSave(text);
      setSaved(text);
      setStatus('Saved');
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function insert(snippet: string) {
    const el = area.current;
    if (!el) return;
    const start = el.selectionStart, end = el.selectionEnd;
    change(text.slice(0, start) + snippet + text.slice(end));
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + snippet.length; });
  }

  const dark = theme === 'dark';
  return (
    <div className={`custom-css-editor custom-css-editor--${theme}`}>
      <label htmlFor={fieldId} className="custom-css-editor__label">{label}</label>
      {help && <div className="custom-css-editor__help">{help}</div>}
      <div className="custom-css-editor__code">
        <div ref={gutter} className="custom-css-editor__gutter" aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => <div key={i} className={problems.some(problem => problem.line === i + 1 && problem.severity === 'error') ? 'is-error' : problems.some(problem => problem.line === i + 1) ? 'is-warning' : ''}>{i + 1}</div>)}
        </div>
        <textarea
          id={fieldId}
          ref={area}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={Math.min(24, Math.max(8, lines + 1))}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby={problems.length ? `${fieldId}-problems` : undefined}
          placeholder={placeholder ?? '.s-eyebrow { letter-spacing: 0.14em; }\n.pricing-note { max-width: 40ch; }'}
          onScroll={e => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
          onChange={e => change(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); insert('  '); }
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && onSave) { e.preventDefault(); void save(); }
          }}
        />
      </div>
      {problems.length > 0 && (
        <ul id={`${fieldId}-problems`} className="custom-css-editor__problems" role={errors.length ? 'alert' : undefined}>
          {problems.map((problem, i) => <li key={i} className={`is-${problem.severity}`}>
            <strong>{problem.severity === 'error' ? 'Error' : 'Warning'}, line {problem.line}:</strong> {problem.message}
          </li>)}
        </ul>
      )}
      {classHints.length > 0 && (
        <div className="custom-css-editor__hints">
          <span>Insert a selector:</span>
          {classHints.map(hint => { const selector = hint.selector ?? `.${hint.className}`; return <button key={selector} type="button" title={hint.label} onClick={() => insert(`${selector} {\n  \n}\n`)}>{selector}</button>; })}
        </div>
      )}
      {onSave && (
        <div className="custom-css-editor__actions">
          <button type="button" className="btn" disabled={saving || errors.length > 0 || text === saved} onClick={() => void save()}>{saving ? 'Saving…' : 'Save CSS'}</button>
          {status && <span role="status">{status}</span>}
        </div>
      )}
      <style>{`
.custom-css-editor { display: grid; gap: .5rem; min-width: 0; }
.custom-css-editor__label { font-weight: 600; font-size: .85rem; }
.custom-css-editor__help { font-size: .8rem; color: ${dark ? '#a1a1aa' : 'var(--color-text-muted)'}; }
.custom-css-editor__code { display: flex; border: 1px solid ${dark ? '#3a3a42' : 'var(--color-border)'}; border-radius: 6px; overflow: hidden; background: ${dark ? '#19191f' : '#fff'}; min-width: 0; }
.custom-css-editor__gutter { padding: 10px 6px; text-align: right; font: 12px/1.6 var(--font-mono, ui-monospace, monospace); color: ${dark ? '#a1a1aa' : '#57534e'}; background: ${dark ? '#141418' : '#f5f5f4'}; user-select: none; overflow: hidden; min-width: 2.5em; }
.custom-css-editor__gutter .is-error { color: ${dark ? '#fca5a5' : '#b91c1c'}; font-weight: 700; }
.custom-css-editor__gutter .is-warning { color: ${dark ? '#fcd34d' : '#92400e'}; font-weight: 700; }
.custom-css-editor textarea { flex: 1; min-width: 0; border: 0 !important; border-radius: 0; resize: vertical; padding: 10px; font: 12px/1.6 var(--font-mono, ui-monospace, monospace); background: transparent !important; color: ${dark ? '#fafafa' : 'var(--color-text)'} !important; white-space: pre; overflow: auto; tab-size: 2; }
.custom-css-editor textarea:focus { outline: 2px solid ${dark ? '#818cf8' : 'var(--color-primary)'}; outline-offset: -2px; }
.custom-css-editor__problems { margin: 0; padding-left: 1.1rem; font-size: .8rem; display: grid; gap: .25rem; }
.custom-css-editor__problems .is-error { color: ${dark ? '#fca5a5' : '#b91c1c'}; }
.custom-css-editor__problems .is-warning { color: ${dark ? '#fcd34d' : '#92400e'}; }
.custom-css-editor__hints { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: .75rem; color: ${dark ? '#a1a1aa' : 'var(--color-text-muted)'}; }
.custom-css-editor__hints button { font: 11px var(--font-mono, ui-monospace, monospace); padding: 2px 6px; border-radius: 4px; border: 1px solid ${dark ? '#3a3a42' : 'var(--color-border)'}; background: ${dark ? '#1f1f23' : '#fff'}; color: ${dark ? '#e4e4e7' : 'var(--color-text)'}; cursor: pointer; }
.custom-css-editor__actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; font-size: .85rem; }
`}</style>
    </div>
  );
}
