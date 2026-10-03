// Native validation of multi-step forms. Every step renders inside one
// <form>, later steps only `hidden`; a required field in a later step must
// not block the earlier steps, and must be enforced once its step shows.
// Drives the real forms runtime against the real submit endpoint.
import { Window } from 'happy-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, renderFormHtml, buildCoreBlockRegistry, FORMS_RUNTIME_JS } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const SECRET = 'c'.repeat(48);

const FORM: Form = {
  id: 'lead',
  name: 'Lead',
  actions: [],
  success_message: 'Thanks!',
  created_at: new Date().toISOString(),
  steps: [
    { id: 'contact', blocks: [
      { id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } },
    ] },
    { id: 'details', blocks: [
      { id: 'c', type: 'form/text', data: { name: 'company', label: 'Company', required: true } },
      { id: 's', type: 'form/select', data: { name: 'size', label: 'Size', required: true, choices: [{ value: 'small', label: 'Small' }] } },
      { id: 'h', type: 'form/hidden', data: { name: 'source', value: 'ads' } },
    ] },
  ],
};

let ipCounter = 0;
const nextIp = () => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function submit(body: FormData): Promise<Response> {
  const { POST } = await import('../../pages/api/forms/submit');
  const req = new Request('http://localhost/api/forms/submit', {
    method: 'POST',
    headers: { 'x-forwarded-for': nextIp(), accept: 'application/json' },
    body,
  });
  return POST({ request: req } as never) as Promise<Response>;
}

type Control = { value: string; disabled: boolean; required: boolean; checkValidity(): boolean };

async function mount() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = SECRET;
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  const { id: _id, ...doc } = FORM;
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/lead`, doc);
  const { signFormToken } = await import('../../lib/forms-signing');
  const window = new Window({ url: 'https://site.example.test/contact' });
  window.document.body.innerHTML = renderFormHtml(
    FORM,
    { submit_url: 'https://forms.example.test/api/forms/submit', submit_token: signFormToken(ORG, SITE, 'lead') },
    { registry: buildCoreBlockRegistry() },
  );
  const posted: Array<Array<[string, string]>> = [];
  window.fetch = (async (_url: unknown, options?: { body?: FormData }) => {
    const entries = Array.from(options!.body!.entries(), ([k, v]) => [k, String(v)] as [string, string]);
    posted.push(entries);
    const fd = new FormData();
    for (const [k, v] of entries) fd.append(k, v);
    const res = await submit(fd);
    return new Response(await res.text(), { status: res.status });
  }) as never;
  window.eval(FORMS_RUNTIME_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const form = window.document.querySelector('form')! as unknown as {
    requestSubmit(): void;
    checkValidity(): boolean;
    querySelector(selector: string): unknown;
  };
  const control = (name: string) => form.querySelector(`[name=${name}]`) as Control;
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { window, form, control, posted, settle };
}

describe('multi-step native validation', () => {
  beforeEach(async () => { await resetDatastore(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('completes step 1 despite a required field in step 2, then enforces it', async () => {
    const ctx = await mount();
    try {
      const step2 = ctx.window.document.querySelector('[data-form-step="details"]') as unknown as { hidden: boolean };
      // Hidden step: controls disabled (barred from validation), not posted.
      expect(step2.hidden).toBe(true);
      expect(ctx.control('company').required).toBe(true);
      expect(ctx.control('company').disabled).toBe(true);
      expect(ctx.control('size').disabled).toBe(true);
      expect(ctx.control('email').disabled).toBe(false);

      // Step 1's own requirement still applies.
      expect(ctx.form.checkValidity()).toBe(false);
      ctx.form.requestSubmit();
      await new Promise((r) => setTimeout(r, 20));
      expect(ctx.posted).toHaveLength(0);

      ctx.control('email').value = 'ada@example.test';
      expect(ctx.form.checkValidity()).toBe(true);
      ctx.form.requestSubmit();
      await ctx.settle(() => !step2.hidden);
      expect(ctx.posted).toHaveLength(1);
      const first = Object.fromEntries(ctx.posted[0]);
      expect(first.email).toBe('ada@example.test');
      expect(first).not.toHaveProperty('company');
      expect(first).not.toHaveProperty('source');
      expect(first._token).toBeTruthy();

      // Step 2 is shown: its controls validate, step 1's are barred.
      expect(step2.hidden).toBe(false);
      expect(ctx.control('company').disabled).toBe(false);
      expect(ctx.control('email').disabled).toBe(true);
      expect(ctx.form.checkValidity()).toBe(false);
      ctx.form.requestSubmit();
      await new Promise((r) => setTimeout(r, 20));
      expect(ctx.posted).toHaveLength(1);

      // The server refuses steps faster than a human; move the clock on.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 5_000);
      ctx.control('company').value = 'Acme';
      ctx.control('size').value = 'small';
      ctx.form.requestSubmit();
      await ctx.settle(() => !!ctx.window.document.querySelector('.form-done'));
      expect(ctx.posted).toHaveLength(2);
      expect(Object.fromEntries(ctx.posted[1])).toMatchObject({ company: 'Acme', size: 'small', source: 'ads' });
      expect(ctx.window.document.querySelector('.form-done')?.textContent).toContain('Thanks!');

      const { getStore } = await import('../../lib/datastore');
      const subs = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ status: 'complete', data: { email: 'ada@example.test', company: 'Acme', size: 'small', source: 'ads' } });
    } finally {
      await ctx.window.happyDOM.close();
    }
  });

  it('keeps controls an author disabled when their step is shown', async () => {
    const window = new Window({ url: 'https://site.example.test/' });
    try {
      window.document.body.innerHTML = `<div data-tr-form="f"><form data-tr-form-el action="https://forms.example.test/api/forms/submit">
<input type="hidden" name="_state" value="" />
<div data-form-step="a"><input name="a" /></div>
<div data-form-step="b" hidden><input name="b" /><input name="locked" disabled /></div>
<div data-form-dynamic-step hidden></div><button type="submit">Send</button></form></div>`;
      const posts: number[] = [];
      window.fetch = (async () => { posts.push(1); return new Response(JSON.stringify({ ok: true, next_step: 'b', state: 's' })); }) as never;
      window.eval(FORMS_RUNTIME_JS);
      window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
      const form = window.document.querySelector('form')! as unknown as { requestSubmit(): void };
      const b = window.document.querySelector('[name=b]') as unknown as Control;
      const locked = window.document.querySelector('[name=locked]') as unknown as Control;
      expect(b.disabled).toBe(true);
      form.requestSubmit();
      for (let i = 0; i < 50 && b.disabled; i++) await new Promise((r) => setTimeout(r, 10));
      expect(b.disabled).toBe(false);
      expect(locked.disabled).toBe(true);
    } finally {
      await window.happyDOM.close();
    }
  });

  it('binds the submit handler once when a dynamic step re-runs init', async () => {
    const window = new Window({ url: 'https://site.example.test/' });
    try {
      window.document.body.innerHTML = `<div data-tr-form="f"><form data-tr-form-el action="https://forms.example.test/api/forms/submit">
<input type="hidden" name="_state" value="" />
<div data-form-step="a"><input name="a" /></div>
<div data-form-dynamic-step hidden></div><button type="submit">Send</button></form></div>`;
      let posts = 0;
      window.fetch = (async () => {
        posts++;
        return new Response(JSON.stringify(posts === 1
          ? { ok: true, html: '<input name="dyn" data-required="true" />', state: 's1' }
          : { ok: true, done: true, message: 'Done' }));
      }) as never;
      window.eval(FORMS_RUNTIME_JS);
      window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
      const form = window.document.querySelector('form')! as unknown as { requestSubmit(): void };
      form.requestSubmit();
      for (let i = 0; i < 50 && !window.document.querySelector('[name=dyn]'); i++) await new Promise((r) => setTimeout(r, 10));
      const dyn = window.document.querySelector('[name=dyn]') as unknown as Control;
      expect(dyn.required).toBe(true);
      expect((window.document.querySelector('[name=a]') as unknown as Control).disabled).toBe(true);
      dyn.value = 'x';
      form.requestSubmit();
      for (let i = 0; i < 50 && !window.document.querySelector('.form-done'); i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 20));
      expect(posts).toBe(2);
    } finally {
      await window.happyDOM.close();
    }
  });
});
