import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '../index.js';
import { renderFormHtml, safeFormRedirectUrl } from '../render-form.js';
import { FORMS_RUNTIME_JS } from '../forms-runtime.js';
import type { Form } from '../types.js';

const registry = buildCoreBlockRegistry();

const render = (success_redirect_url?: string) => renderFormHtml({
  id: 'kontakt', name: 'Kontakt', actions: [], created_at: 'x', success_redirect_url,
  steps: [{ id: 's1', blocks: [{ id: 'b1', type: 'form/text', data: { name: 'namn', label: 'Namn' } }] }],
} as Form, { submit_url: 'https://api.example/submit', submit_token: null }, { registry });

describe('safeFormRedirectUrl', () => {
  it('accepts http(s) and root-relative targets', () => {
    expect(safeFormRedirectUrl('https://cal.com/example/intro')).toBe('https://cal.com/example/intro');
    expect(safeFormRedirectUrl(' /tack/ ')).toBe('/tack/');
    expect(safeFormRedirectUrl('http://example.se/a?b=c')).toBe('http://example.se/a?b=c');
  });

  it('rejects scripts, protocol-relative and malformed targets', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', '/\\evil.example', 'tack', 'https://a b', '', undefined, 42]) {
      expect(safeFormRedirectUrl(bad)).toBe('');
    }
  });
});

describe('renderFormHtml redirect flag', () => {
  it('emits data-redirect only for safe targets', () => {
    expect(render('https://cal.com/example/intro')).toContain('data-redirect="https://cal.com/example/intro"');
    expect(render('javascript:alert(1)')).not.toContain('data-redirect');
    expect(render()).not.toContain('data-redirect');
  });

  it('runtime follows the flag after completion', () => {
    expect(FORMS_RUNTIME_JS).toContain('data-redirect');
    expect(FORMS_RUNTIME_JS).toContain('location.assign(redirect)');
  });
});
