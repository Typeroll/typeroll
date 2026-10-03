// Multi-step form navigation: step visibility, per-step button labels, back
// navigation, step titles, step announcements and the progress indicator.
import { Window } from 'happy-dom';
import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '../index.js';
import { FORM_SHELL_CSS, renderFormHtml } from '../render-form.js';
import { FORMS_RUNTIME_JS } from '../forms-runtime.js';
import type { Form } from '../types.js';

const registry = buildCoreBlockRegistry();

const LEAD: Form = {
  id: 'lead', name: 'Lead', actions: [], created_at: 'x', submit_text: 'Anmäl intresse',
  steps: [
    { id: 'contact', title: 'Kontakt', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'E-post', required: true } }] },
    { id: 'company', title: 'Företag', blocks: [{ id: 'c', type: 'form/text', data: { name: 'company', label: 'Företag', required: true } }] },
    { id: 'message', title: 'Meddelande', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Meddelande' } }] },
  ],
};

const embed = { submit_url: 'https://forms.example/api/forms/submit', submit_token: 'tok' };

describe('hidden steps', () => {
  it('stay hidden when site CSS changes the display of steps', async () => {
    const window = new Window({ url: 'https://site.example/' });
    try {
      window.document.head.innerHTML = `<style>[data-form-step], [data-form-dynamic-step] { display: contents; }</style><style>${FORM_SHELL_CSS}</style>`;
      window.document.body.innerHTML = renderFormHtml(LEAD, embed, { registry });
      const display = (selector: string) => window.getComputedStyle(window.document.querySelector(selector)!).display;
      expect(display('[data-form-step="contact"]')).toBe('contents');
      expect(display('[data-form-step="company"]')).toBe('none');
      expect(display('[data-form-dynamic-step]')).toBe('none');
    } finally {
      await window.happyDOM.close();
    }
  });
});

const render = (form: Form, renderVersion?: number, lang = 'sv') => renderFormHtml(form, embed, { registry, renderVersion, lang });
const button = (html: string) => /<button type="submit" class="form-submit">([^<]*)<\/button>/.exec(html)?.[1];
const stepLabels = (html: string) => [...html.matchAll(/data-form-step="([^"]+)" data-submit-label="([^"]*)"/g)].map((m) => [m[1], m[2]]);

describe('per-step button labels', () => {
  it('render version 5: Continue before the last step, the submit text on it', () => {
    const html = render(LEAD, 5);
    expect(button(html)).toBe('Fortsätt');
    expect(stepLabels(html)).toEqual([['contact', 'Fortsätt'], ['company', 'Fortsätt'], ['message', 'Anmäl intresse']]);
    expect(html).toContain('data-label-continue="Fortsätt" data-label-final="Anmäl intresse"');
    expect(render(LEAD, 5, 'en')).toContain('data-submit-label="Continue"');
  });

  it("a step's own label wins on every render version", () => {
    const form = { ...LEAD, steps: [{ ...LEAD.steps![0]!, submit_label: 'Nästa: företag' }, ...LEAD.steps!.slice(1)] };
    expect(button(render(form, 5))).toBe('Nästa: företag');
    const legacy = render(form, 4);
    expect(button(legacy)).toBe('Nästa: företag');
    expect(stepLabels(legacy)).toEqual([['contact', 'Nästa: företag'], ['company', 'Anmäl intresse'], ['message', 'Anmäl intresse']]);
  });

  it('leaves forms without labels unchanged before render version 5, and single-step forms always', () => {
    for (const html of [render(LEAD, 4), render(LEAD)]) {
      expect(button(html)).toBe('Anmäl intresse');
      expect(html).not.toContain('data-submit-label');
      expect(html).not.toContain('data-label-continue');
    }
    const single = render({ ...LEAD, steps: [LEAD.steps![0]!] }, 5);
    expect(button(single)).toBe('Anmäl intresse');
    expect(single).not.toContain('data-submit-label');
    expect(single).not.toContain('data-form-back');
  });
});

describe('back button', () => {
  it('is on by default from render version 5 and hidden until the second step', () => {
    expect(render(LEAD, 5)).toContain('<button type="button" class="form-back" data-form-back hidden>Tillbaka</button>');
    expect(render(LEAD, 5, 'en')).toContain('data-form-back hidden>Back</button>');
    expect(render(LEAD, 4)).not.toContain('data-form-back');
  });

  it('follows allow_back on every render version', () => {
    expect(render({ ...LEAD, allow_back: false }, 5)).not.toContain('data-form-back');
    expect(render({ ...LEAD, allow_back: true }, 1)).toContain('data-form-back');
  });
});

describe('step titles', () => {
  const withHeading: Form = { ...LEAD, steps: [{ id: 'one', title: 'Kontakt', blocks: [
    { id: 'h', type: 'form/heading', data: { text: 'Kontakt' } },
    { id: 'e', type: 'form/email', data: { name: 'email', label: 'E-post' } },
  ] }, LEAD.steps![1]!] };

  it('omits the title of a step that starts with a form heading from render version 5', () => {
    const html = render(withHeading, 5);
    expect(html.match(/Kontakt/g)).toHaveLength(1);
    expect(html).not.toContain('<h3 class="form-step-title">Kontakt</h3>');
    expect(html).toContain('<h3 class="form-step-title">Företag</h3>');
  });

  it('keeps both before render version 5', () => {
    expect(render(withHeading, 4)).toContain('<h3 class="form-step-title">Kontakt</h3>');
  });
});

describe('progress indicator', () => {
  it('is off by default', () => {
    expect(render(LEAD, 5)).not.toContain('form-progress');
  });

  it('renders "Step X of Y" over the steps on the path', () => {
    const form: Form = { ...LEAD, show_progress: true, steps: [{ ...LEAD.steps![0]!, next: 'message' }, ...LEAD.steps!.slice(1)] };
    const html = render(form, 1);
    expect(html).toContain('<div class="form-progress" data-form-progress="text" data-progress-template="Steg {n} av {total}" data-progress-total="2"><span class="form-progress-text">Steg 1 av 2</span>');
    expect(render({ ...LEAD, show_progress: 'bar' }, 1, 'en')).toContain('data-form-progress="bar" data-progress-template="Step {n} of {total}" data-progress-total="3"><span class="form-progress-text">Step 1 of 3</span><span class="form-progress-bar" aria-hidden="true"><span class="form-progress-fill" style="width:33.33%">');
    expect(render({ ...LEAD, show_progress: true, steps: [LEAD.steps![0]!] }, 5)).not.toContain('form-progress');
  });
});

type El = { value: string; hidden: boolean; disabled: boolean; textContent: string | null; click(): void };

async function mount(form: Form, respond: (body: Record<string, string>) => unknown, renderVersion = 5) {
  const window = new Window({ url: 'https://site.example/' });
  window.document.body.innerHTML = renderFormHtml(form, embed, { registry, renderVersion, lang: 'en' });
  const posts: Array<Record<string, string>> = [];
  window.fetch = (async (_url: unknown, options: { body: FormData }) => {
    const body = Object.fromEntries(Array.from(options.body.entries(), ([k, v]) => [k, String(v)]));
    posts.push(body);
    return new Response(JSON.stringify(respond(body)));
  }) as never;
  window.eval(FORMS_RUNTIME_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const el = (selector: string) => window.document.querySelector(selector) as unknown as El;
  const submit = async () => {
    (window.document.querySelector('form') as unknown as { requestSubmit(): void }).requestSubmit();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
  };
  return { window, el, submit, posts, live: () => el('.form-step-status').textContent };
}

describe('runtime step navigation', () => {
  const EN: Form = { ...LEAD, submit_text: 'Register interest', show_progress: true, steps: [
    { id: 'contact', title: 'Contact', blocks: [{ id: 'e', type: 'form/email', data: { name: 'email', label: 'Email', required: true } }] },
    { id: 'company', title: 'Company', blocks: [{ id: 'c', type: 'form/text', data: { name: 'company', label: 'Company name', required: true } }] },
    { id: 'message', title: 'Message', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Message' } }] },
  ] };
  const server = (body: Record<string, string>) => ({ ok: true, v: 1, state: `after-${body._step}`, next_step: { contact: 'company', company: 'message' }[body._step] });

  it('labels the button, announces the step and focuses it on every change', async () => {
    const ctx = await mount(EN, server);
    try {
      const btn = ctx.el('.form-submit');
      expect(btn.textContent).toBe('Continue');
      expect(ctx.el('[data-form-back]').hidden).toBe(true);
      ctx.el('[name=email]').value = 'ada@example.test';
      await ctx.submit();
      expect(ctx.el('[data-form-step=company]').hidden).toBe(false);
      expect(btn.textContent).toBe('Continue');
      expect(ctx.live()).toBe('Step 2 of 3: Company');
      expect(ctx.el('.form-progress-text').textContent).toBe('Step 2 of 3');
      expect(ctx.window.document.activeElement?.textContent).toBe('Company');
      expect(ctx.el('[data-form-back]').hidden).toBe(false);
      ctx.el('[name=company]').value = 'Acme';
      await ctx.submit();
      expect(btn.textContent).toBe('Register interest');
      expect(ctx.live()).toBe('Step 3 of 3: Message');
      expect(ctx.posts.map((p) => p._step)).toEqual(['contact', 'company']);
    } finally {
      await ctx.window.happyDOM.close();
    }
  });

  it('goes back without a request, keeps the entered values and sends the earlier step again', async () => {
    const ctx = await mount(EN, server);
    try {
      ctx.el('[name=email]').value = 'ada@example.test';
      await ctx.submit();
      ctx.el('[name=company]').value = 'Acme';
      ctx.el('[data-form-back]').click();
      await new Promise((r) => setTimeout(r, 5));
      expect(ctx.posts).toHaveLength(1);
      expect(ctx.el('[data-form-step=contact]').hidden).toBe(false);
      expect(ctx.el('[data-form-step=company]').hidden).toBe(true);
      expect(ctx.el('[name=email]').value).toBe('ada@example.test');
      expect(ctx.el('[name=email]').disabled).toBe(false);
      expect(ctx.el('[data-form-back]').hidden).toBe(true);
      expect(ctx.el('.form-submit').textContent).toBe('Continue');
      expect(ctx.live()).toBe('Step 1 of 3: Contact');

      // Sending step 1 again names it and keeps the latest continuation.
      await ctx.submit();
      expect(ctx.posts[1]).toMatchObject({ _step: 'contact', _state: 'after-contact', email: 'ada@example.test' });
      expect(ctx.el('[name=company]').value).toBe('Acme');
    } finally {
      await ctx.window.happyDOM.close();
    }
  });

  it('labels and returns to server-rendered dynamic steps', async () => {
    const form: Form = { ...EN, steps: [EN.steps![0]!, { id: 'quote', render: 'dynamic', blocks: [] }, EN.steps![2]!] };
    const ctx = await mount(form, (body) => body._step === 'contact'
      ? { ok: true, html: '<h3 class="form-step-title">Your quote</h3><input name="accept" />', state: 's1', step: 'quote', submit_label: null, final: false }
      : { ok: true, next_step: 'message', state: 's2' });
    try {
      expect(ctx.window.document.querySelector('form')!.getAttribute('data-render-version')).toBe('5');
      ctx.el('[name=email]').value = 'ada@example.test';
      await ctx.submit();
      expect(ctx.posts[0]._rv).toBe('5');
      expect(ctx.el('[data-form-dynamic-step]').hidden).toBe(false);
      expect(ctx.el('.form-submit').textContent).toBe('Continue');
      expect(ctx.live()).toBe('Step 2 of 3: Your quote');
      ctx.el('[name=accept]').value = 'yes';
      await ctx.submit();
      expect(ctx.posts[1]._step).toBe('quote');
      expect(ctx.el('[data-form-dynamic-step]').hidden).toBe(true);
      expect(ctx.el('[data-form-step=message]').hidden).toBe(false);
      ctx.el('[data-form-back]').click();
      expect(ctx.el('[data-form-dynamic-step]').hidden).toBe(false);
      expect(ctx.el('[name=accept]').value).toBe('yes');
      ctx.el('[data-form-back]').click();
      expect(ctx.el('[data-form-step=contact]').hidden).toBe(false);
      expect(ctx.el('[data-form-dynamic-step]').hidden).toBe(true);
    } finally {
      await ctx.window.happyDOM.close();
    }
  });

  it('keeps forms without the new options as they were', async () => {
    const ctx = await mount(LEAD, (body) => ({ ok: true, next_step: 'company', state: 's', echo: body }), 4);
    try {
      ctx.el('[name=email]').value = 'ada@example.test';
      await ctx.submit();
      expect(ctx.posts[0]).not.toHaveProperty('_step');
      expect(ctx.posts[0]).not.toHaveProperty('_rv');
      expect(ctx.el('.form-submit').textContent).toBe('Anmäl intresse');
      expect(ctx.window.document.querySelector('[data-form-back]')).toBeNull();
      expect(ctx.live()).toBe('Företag');
    } finally {
      await ctx.window.happyDOM.close();
    }
  });
});
