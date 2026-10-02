// Forms in previews: the portal renders them with `preview` and the runtime
// plays the submit endpoint's part in the browser. Steps advance, validation
// and the success message or redirect behave as in production, and nothing
// is ever sent.
import { Window } from 'happy-dom';
import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '../index.js';
import { formPreviewSteps, renderFormHtml, FORM_PREVIEW_FIELD } from '../render-form.js';
import { FORMS_RUNTIME_JS } from '../forms-runtime.js';
import type { Form } from '../types.js';

const registry = buildCoreBlockRegistry();

const FORM: Form = {
  id: 'lead',
  name: 'Lead',
  actions: [],
  created_at: 'x',
  success_message: 'Thanks, <strong>talk soon</strong>.',
  submit_text: 'Send',
  steps: [
    { id: 'contact', next: 'extra', blocks: [
      { id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } },
      { id: 'g', type: 'form/checkbox_group', data: { name: 'topics', label: 'Topics', required: true, choices: [{ value: 'seo', label: 'SEO' }, { value: 'ads', label: 'Ads' }] } },
    ] },
    { id: 'skipped', blocks: [
      { id: 'x', type: 'form/text', data: { name: 'never', label: 'Never', required: true } },
    ] },
    { id: 'extra', render: 'dynamic', blocks: [
      { id: 'c', type: 'form/text', data: { name: 'code', label: 'Code', pattern: '[A-Z]{3}', min: 3, max: 3 } },
    ] },
  ],
};

const render = (form: Form = FORM, opts: { lang?: string } = {}) =>
  renderFormHtml(form, { submit_url: 'https://forms.example/api/forms/submit', submit_token: 'real.token.value.sig', preview: true }, { registry, pow_bits: 15, ...opts });

describe('preview form markup', () => {
  it('carries the step graph and the server rules, a notice, and no token or proof of work', () => {
    const html = render();
    expect(html).toContain('data-tr-preview="');
    expect(html).toMatch(/<p class="form-preview-notice" role="note" style="[^"]+">Preview – nothing is sent<\/p>/);
    expect(html).toContain(`<input type="hidden" name="${FORM_PREVIEW_FIELD}" value="1" />`);
    expect(html).toContain('<input type="hidden" name="_token" value="" />');
    expect(html).not.toContain('real.token.value.sig');
    expect(html).toContain('data-pow-bits="0"');
    // Dynamic steps have no forms service to render them in a preview.
    expect(html).toContain('data-form-step="extra" hidden');
  });

  it('localizes the notice for Swedish sites', () => {
    expect(render(FORM, { lang: 'sv' })).toContain('Förhandsvisning – inget skickas');
    expect(render(FORM, { lang: 'sv' })).toContain('data-msg-redirect="Förhandsvisning – skulle skicka vidare till"');
  });

  it('mirrors nextStep and the server messages', () => {
    expect(formPreviewSteps(FORM)).toEqual([
      { id: 'contact', next: 'extra', fields: [
        { name: 'email', type: 'email', required: true, messages: { required: 'Email is required', invalid_email: "Email doesn't look like a valid email address" } },
        { name: 'topics', type: 'checkbox', required: true, list: true, messages: { required: 'Topics is required' } },
      ] },
      { id: 'skipped', next: 'extra', fields: [{ name: 'never', type: 'text', required: true, messages: { required: 'Never is required' } }] },
      { id: 'extra', next: null, fields: [{ name: 'code', type: 'text', pattern: '[A-Z]{3}', min: 3, max: 3, messages: { pattern: 'Code has the wrong format', min: 'Code is too short/low', max: 'Code is too long/high' } }] },
    ]);
  });

  it('is absent unless the embed asks for it', () => {
    const html = renderFormHtml(FORM, { submit_url: 'https://forms.example/api/forms/submit', submit_token: 'real.token.value.sig' }, { registry, pow_bits: 15 });
    expect(html).not.toContain('data-tr-preview');
    expect(html).not.toContain('form-preview-notice');
    expect(html).not.toContain(FORM_PREVIEW_FIELD);
    expect(html).toContain('value="real.token.value.sig"');
    expect(html).not.toContain('data-form-step="extra"');
  });
});

type El = { value: string; checked: boolean; hidden: boolean; textContent: string | null };

async function mount(form: Form, url = 'https://portal.example/preview/site/contact?t=x') {
  const window = new Window({ url });
  window.document.body.innerHTML = render(form);
  const requests: unknown[] = [];
  window.fetch = (async (...args: unknown[]) => { requests.push(args); return new Response('{}'); }) as never;
  window.eval(FORMS_RUNTIME_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const el = (selector: string) => window.document.querySelector(selector) as unknown as El;
  const submit = async () => {
    (window.document.querySelector('form') as unknown as { requestSubmit(): void }).requestSubmit();
    await new Promise((r) => setTimeout(r, 5));
  };
  return { window, el, submit, requests };
}

describe('preview runtime', () => {
  it('validates like the server, follows the step graph and completes without sending', async () => {
    const ctx = await mount(FORM);
    try {
      // Natively valid (a@b) but refused by the server's address rule; the
      // empty checkbox group is a server-only requirement.
      ctx.el('[name=email]').value = 'a@b';
      await ctx.submit();
      expect(ctx.el('[data-error-for=email]').textContent).toBe("Email doesn't look like a valid email address");
      expect(ctx.el('[data-error-for=topics]').textContent).toBe('Topics is required');
      expect(ctx.el('[data-form-step=contact]').hidden).toBe(false);

      ctx.el('[name=email]').value = 'ada@example.test';
      ctx.el('[name=topics][value=ads]').checked = true;
      await ctx.submit();
      // `next` skips the middle step and its required field.
      expect(ctx.el('[data-form-step=contact]').hidden).toBe(true);
      expect(ctx.el('[data-form-step=skipped]').hidden).toBe(true);
      expect(ctx.el('[data-form-step=extra]').hidden).toBe(false);

      ctx.el('[name=code]').value = 'ab1';
      await ctx.submit();
      expect(ctx.el('[data-error-for=code]').textContent).toBe('Code has the wrong format');
      ctx.el('[name=code]').value = 'ABC';
      await ctx.submit();

      const done = ctx.el('.form-done') as unknown as { innerHTML: string };
      expect(done.innerHTML).toBe('Thanks, <strong>talk soon</strong>.');
      expect(ctx.el('.form-preview-notice').textContent).toBe('Preview – nothing is sent');
      expect(ctx.requests).toHaveLength(0);
    } finally {
      await ctx.window.happyDOM.close();
    }
  });

  it('names the redirect target instead of leaving the preview', async () => {
    const ctx = await mount({ ...FORM, success_redirect_url: '/tack/', steps: [FORM.steps![2]!] });
    try {
      await ctx.submit();
      expect(ctx.el('.form-done').textContent).toBe('Preview – would redirect to /tack/');
      expect(ctx.window.location.href).toBe('https://portal.example/preview/site/contact?t=x');
      expect(ctx.requests).toHaveLength(0);
    } finally {
      await ctx.window.happyDOM.close();
    }
  });

  it('does not hydrate or exchange session links of app-backed forms', async () => {
    const ctx = await mount(
      { ...FORM, target: { installation_id: 'app', path: '/edit', hydrate: true, session_param: 't' }, steps: [FORM.steps![2]!] },
      'https://portal.example/preview/site/edit?t=one-time',
    );
    try {
      await new Promise((r) => setTimeout(r, 10));
      expect(ctx.window.location.href).toContain('t=one-time');
      expect(ctx.el('.form-toplevel-error').hidden).toBe(true);
      ctx.el('[name=code]').value = 'ABC';
      await ctx.submit();
      expect(ctx.el('.form-done')).toBeTruthy();
      expect(ctx.requests).toHaveLength(0);
    } finally {
      await ctx.window.happyDOM.close();
    }
  });
});
