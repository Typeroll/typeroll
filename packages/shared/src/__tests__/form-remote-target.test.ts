/**
 * Remote-backed forms — the app-agnostic half.
 *
 * The forms module must not know which app wants a prefilled, session-bound
 * form. It implements two declared behaviours (hydrate, session exchange) and
 * the app names itself only so the BUILD can resolve an endpoint. These tests
 * exist mostly to keep an app name from creeping back into form code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildCoreBlockRegistry } from '../index.js';
import { renderFormHtml } from '../render-form.js';
import { FORMS_RUNTIME_JS } from '../forms-runtime.js';
import type { Form } from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const registry = buildCoreBlockRegistry();

const form = (target?: Form['target']): Form => ({
  id: 'edit', name: 'Edit', actions: [], created_at: 'x', target,
  steps: [{
    id: 's1',
    blocks: [{ id: 'b1', type: 'form/text', data: { name: 'phone', label: 'Phone' } }],
  }],
} as Form);

const render = (t?: Form['target']) =>
  renderFormHtml(form(t), { submit_url: 'https://api.example/edit', submit_token: null }, { registry });

describe('capability flags are generic', () => {
  it('emits nothing extra for an ordinary form', () => {
    const html = render();
    expect(html).not.toContain('data-tr-hydrate');
    expect(html).not.toContain('data-tr-session-param');
  });

  it('flags prefill', () => {
    expect(render({ hydrate: true })).toContain('data-tr-hydrate="1"');
  });

  it('flags the session parameter by NAME, not by app', () => {
    const html = render({ session_param: 't', app: 'directory' });
    expect(html).toContain('data-tr-session-param="t"');
    // The app that asked is the build's business, not the browser's.
    expect(html).not.toContain('directory');
  });

  it('escapes the parameter name', () => {
    expect(render({ session_param: 'a"b' })).toContain('data-tr-session-param="a&quot;b"');
  });

  it('still posts to whatever submit_url it was given', () => {
    expect(render({ hydrate: true })).toContain('action="https://api.example/edit"');
  });
});

describe('the runtime names no app', () => {
  it('has no app identifier in its executable source', () => {
    // The guard that matters: a future app must not be able to earn a branch
    // in here. Comments may cite an app as an example; code may not.
    const code = FORMS_RUNTIME_JS
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    for (const app of ['directory', 'analytics', 'integrations']) {
      expect(code.toLowerCase()).not.toContain(app);
    }
  });

  it('parses', () => {
    // It ships verbatim into every visitor's browser; a syntax error here
    // breaks every form on every site at once.
    expect(() => new Function(FORMS_RUNTIME_JS)).not.toThrow();
  });

  it('reads the generic attributes the renderer emits', () => {
    expect(FORMS_RUNTIME_JS).toContain('data-tr-session-param');
    expect(FORMS_RUNTIME_JS).toContain('data-tr-hydrate');
  });

  it('strips the one-time token from the URL after exchanging it', () => {
    // Otherwise the link sits in history and bookmarks, and leaks through
    // Referer to anything the page loads.
    expect(FORMS_RUNTIME_JS).toContain('searchParams.delete(param)');
    expect(FORMS_RUNTIME_JS).toContain('history.replaceState');
  });

  it('keeps the session in sessionStorage, not a cookie', () => {
    // Cross-origin means a cookie would be third-party, and those are blocked.
    expect(FORMS_RUNTIME_JS).toContain('sessionStorage');
  });
});

describe('render-form source stays app-free', () => {
  it('mentions no app name', () => {
    const src = readFileSync(resolve(HERE, '..', 'render-form.ts'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(src).not.toContain('directory');
  });
});
