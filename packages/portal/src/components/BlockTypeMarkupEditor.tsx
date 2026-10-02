// Markup tab of the block type builder (template mode): a code field with
// line numbers, suggestions for field names and sections at the cursor, and
// the shared validator's template problems marked on their lines.

import { useId, useMemo, useRef, useState } from 'react';
import type { BlockTypeProblem, FieldDefinition } from '@typeroll/shared';
import { templateCompletions, type Completion } from '../lib/block-type-builder';

export default function BlockTypeMarkupEditor({ value, schema, problems, onChange, blockName }: {
  value: string;
  schema: FieldDefinition[];
  /** Validator problems with path `/template`. */
  problems: BlockTypeProblem[];
  onChange: (template: string) => void;
  blockName: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const listId = useId();
  const helpId = useId();
  const [suggest, setSuggest] = useState<{ from: number; items: Completion[] } | null>(null);
  const [active, setActive] = useState(0);
  const lines = value.split('\n').length;
  const lineState = useMemo(() => {
    const out = new Map<number, 'error' | 'warning'>();
    for (const problem of problems) if (problem.line && out.get(problem.line) !== 'error') out.set(problem.line, problem.severity);
    return out;
  }, [problems]);

  const refresh = (text: string, caret: number) => {
    const result = templateCompletions(schema, text.slice(0, caret));
    setSuggest(result && result.items.length ? result : null);
    setActive(0);
  };
  const accept = (item: Completion) => {
    const el = area.current;
    if (!el || !suggest) return;
    const caret = el.selectionStart;
    const next = value.slice(0, suggest.from) + item.insert + value.slice(caret);
    onChange(next);
    // Land inside a section body when one was inserted, otherwise after the token.
    const close = item.insert.indexOf('}}');
    const bodyAt = item.insert.includes('\n  \n') ? item.insert.indexOf('\n  \n') + 3 : close >= 0 && item.insert.indexOf('{{/') > close ? close + 2 : item.insert.length;
    const position = suggest.from + bodyAt;
    setSuggest(null);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = position; });
  };

  return (
    <div className="bb-panel">
      <label htmlFor={`${listId}-area`} className="bb-field" style={{ marginBottom: 6 }}><span>Markup</span></label>
      <p id={helpId} className="bb-help" style={{ margin: '0 0 .5rem' }}>
        HTML with fields in double braces. Type <code>{'{{'}</code> for suggestions; use the arrow keys and Enter to insert one. The output is sanitized: no scripts or event handlers.
      </p>
      <div className="bb-code">
        <div ref={gutter} className="bb-code__gutter" aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => <div key={i} className={lineState.get(i + 1) === 'error' ? 'is-error' : lineState.get(i + 1) === 'warning' ? 'is-warning' : ''}>{i + 1}</div>)}
        </div>
        <textarea
          id={`${listId}-area`}
          ref={area}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={Math.min(30, Math.max(12, lines + 2))}
          aria-describedby={`${helpId}${problems.length ? ` ${listId}-problems` : ''}`}
          aria-invalid={problems.some(problem => problem.severity === 'error') || undefined}
          aria-autocomplete="list"
          aria-controls={suggest ? listId : undefined}
          aria-activedescendant={suggest ? `${listId}-${active}` : undefined}
          placeholder={`<div class="${blockName || 'my-block'}">\n  <h2>{{title}}</h2>\n</div>`}
          onScroll={e => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
          onChange={e => { onChange(e.target.value); refresh(e.target.value, e.target.selectionStart); }}
          onClick={e => refresh(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => window.setTimeout(() => setSuggest(null), 150)}
          onKeyDown={e => {
            if (suggest) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % suggest.items.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + suggest.items.length) % suggest.items.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(suggest.items[active]!); return; }
              if (e.key === 'Escape') { e.preventDefault(); setSuggest(null); return; }
            }
            if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              const el = e.currentTarget, start = el.selectionStart, end = el.selectionEnd;
              onChange(value.slice(0, start) + '  ' + value.slice(end));
              requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
            }
          }}
        />
      </div>
      {suggest && (
        <ul id={listId} className="bb-suggest" role="listbox" aria-label="Suggestions">
          {suggest.items.map((item, index) => (
            <li key={item.label} id={`${listId}-${index}`} role="option" aria-selected={index === active}
              onMouseDown={e => { e.preventDefault(); accept(item); }}>
              <span>{item.label}</span><span>{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <ul id={`${listId}-problems`} className="bb-problems" style={{ marginTop: '.5rem' }}>
          {problems.map((problem, i) => <li key={i} className={`is-${problem.severity}`}><strong>{problem.severity === 'error' ? 'Error' : 'Warning'}{problem.line ? `, line ${problem.line}` : ''}:</strong> {problem.message}</li>)}
        </ul>
      )}
      <details className="bb-details" style={{ marginTop: '1rem' }}>
        <summary>Template syntax</summary>
        <dl className="bb-syntax">
          <dt>{'{{title}}'}</dt><dd>A field, HTML-escaped.</dd>
          <dt>{'{{{body}}}'}</dt><dd>Raw HTML: only formatted text fields and derived HTML such as <code>{'{{{icon_svg}}}'}</code>.</dd>
          <dt>{'{{#each items}}…{{/each}}'}</dt><dd>Repeat for each list item. Inside: the item's fields, <code>{'{{@index}}'}</code>, <code>{'{{@number}}'}</code>, <code>{'{{@first}}'}</code>, <code>{'{{@last}}'}</code>.</dd>
          <dt>{'{{#field}}…{{/field}}'}</dt><dd>Shown when the field has a value.</dd>
          <dt>{'{{^field}}…{{/field}}'}</dt><dd>Shown when the field is empty.</dd>
          <dt>{'{{#link link class="x"}}…{{/link}}'}</dt><dd>Wraps the content in a link when the link field has an address.</dd>
          <dt>{'{{link.href}}'}</dt><dd>A link field's address; also <code>.target</code> and <code>.rel</code>.</dd>
          <dt>{'{{page.title}} {{site.name}}'}</dt><dd>Values of the page and the Site.</dd>
          <dt>{'{{children}}'}</dt><dd>Child blocks, for container block types.</dd>
        </dl>
      </details>
    </div>
  );
}
