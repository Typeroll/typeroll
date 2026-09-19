import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { FORMS_RUNTIME_JS, renderFormHtml, buildCoreBlockRegistry, type Form } from '@typeroll/shared';
import { validInstallationFormTarget } from '../../lib/apps/form-endpoint';

async function fixture(initial: boolean | null = null) {
  const window = new Window({ url: 'https://site.example.test/edit?page_id=company' });
  const form: Form = { id: 'edit', name: 'Edit', created_at: 'T', actions: [], target: { installation_id: 'app', path: '/edit', hydrate: true, context_params: ['page_id'] }, steps: [{ id: 'one', blocks: [
    { id: 'online', type: 'form/boolean', data: { name: 'online', label: 'Online sales?' } },
    { id: 'phone', type: 'form/text', data: { name: 'phone', label: 'Phone' } },
  ] }] };
  window.document.body.innerHTML = renderFormHtml(form, { submit_url: 'https://app.example.test/edit', submit_token: null }, { registry: buildCoreBlockRegistry() });
  const requests: Array<Record<string, unknown>> = [];
  window.fetch = (async (_url: unknown, options?: { method?: string; body?: FormData }) => {
    if (options?.method === 'POST') { requests.push(Object.fromEntries(options.body!.entries())); return new Response(JSON.stringify({ ok: true, done: true, message: 'Awaiting review' })); }
    return new Response(JSON.stringify({ revision: 'revision-1', fields: [{ name: 'online', type: 'boolean', value: initial }, { name: 'phone', type: 'text', value: 'Imported' }] }));
  }) as any;
  window.eval(FORMS_RUNTIME_JS); window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 5));
  return { window, requests, form: window.document.querySelector('form')! };
}
describe('native answer form wire contract', () => {
  it('sends explicit No without re-confirming unchanged imported fields', async () => {
    const ctx = await fixture();
    try {
      expect(ctx.form.querySelectorAll('input[type=radio]:checked')).toHaveLength(0);
      const no = ctx.form.querySelector('input[value=false]')! as any; no.checked = true; no.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
      ctx.form.dispatchEvent(new ctx.window.Event('submit', { cancelable: true })); await new Promise(resolve => setTimeout(resolve, 5));
      expect(ctx.requests).toHaveLength(1); expect(ctx.requests[0].online).toBe('false'); expect(ctx.requests[0]).not.toHaveProperty('phone');
      expect(ctx.requests[0]._base_revision).toBe('revision-1'); expect(ctx.requests[0]._request_id).toBeTruthy();
      expect(ctx.window.document.body.textContent).toContain('Awaiting review');
    } finally { await ctx.window.happyDOM.close(); }
  });
  it('omits untouched unknown values and keeps the honeypot outside keyboard and accessibility flow', async () => {
    const ctx = await fixture();
    try {
      const phone = ctx.form.querySelector('[name=phone]')! as any; phone.value = 'Updated'; phone.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
      const trap = ctx.form.querySelector('[name=_hp]')!; expect(trap.getAttribute('tabindex')).toBe('-1'); expect(trap.closest('[hidden]')).toBeTruthy();
      ctx.form.dispatchEvent(new ctx.window.Event('submit', { cancelable: true })); await new Promise(resolve => setTimeout(resolve, 5));
      expect(ctx.requests[0]).not.toHaveProperty('online'); expect(ctx.requests[0].phone).toBe('Updated');
    } finally { await ctx.window.happyDOM.close(); }
  });
  it('submits a deliberate reset as null, not No', async () => {
    const ctx = await fixture(true);
    try {
      (ctx.form.querySelector('[data-clear-answer]')! as any).click();
      ctx.form.dispatchEvent(new ctx.window.Event('submit', { cancelable: true })); await new Promise(resolve => setTimeout(resolve, 5));
      expect(ctx.requests[0].online).toBe('null'); expect(ctx.requests[0]).not.toHaveProperty('phone');
    } finally { await ctx.window.happyDOM.close(); }
  });
  it('accepts explicit profile context but rejects security-parameter overrides', () => {
    expect(validInstallationFormTarget({ installation_id: 'app', path: '/request-link', context_params: ['page_id'] })).toBe(true);
    for (const key of ['issuer', 'site_id', 'installation_id', 'session', 't']) expect(validInstallationFormTarget({ installation_id: 'app', path: '/request-link', session_param: 't', context_params: [key] })).toBe(false);
  });
});
