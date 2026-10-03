// Visitor-facing form texts in the site's language: the shared message
// table, the messages the form shell renders for the runtime, the runtime's
// use of them, campaign parameters in hidden fields and the Extension
// runtime's fallback.
import { Window } from 'happy-dom';
import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '../index.js';
import { formMessage } from '../form-fields.js';
import { renderFormHtml } from '../render-form.js';
import { FORMS_RUNTIME_JS } from '../forms-runtime.js';
import { buildExtensionRuntimeScript } from '../extensions-runtime.js';
import type { Form } from '../types.js';

const registry = buildCoreBlockRegistry();
const embed = { submit_url: 'https://forms.example/api/forms/submit', submit_token: 'tok' };

const CONTACT: Form = {
  id: 'contact', name: 'Contact', actions: [], created_at: 'x',
  steps: [{ id: 'main', blocks: [
    { id: 'e', type: 'form/email', data: { name: 'email', label: 'E-post' } },
    { id: 's', type: 'form/hidden', data: { name: 'utm_source', value: '' } },
    { id: 'm', type: 'form/hidden', data: { name: 'utm_medium', value: 'website' } },
    { id: 'r', type: 'form/hidden', data: { name: 'ref', value: 'footer' } },
  ] }],
};
const REMOTE: Form = { ...CONTACT, id: 'remote', target: { app: 'example', hydrate: true } };

type Fetch = (url: string, init?: { method?: string; body?: FormData }) => Promise<Response>;

async function withForm(form: Form, lang: string, url: string, fetchImpl: Fetch, run: (window: Window, el: HTMLFormElement) => Promise<void>) {
  const window = new Window({ url });
  try {
    window.document.documentElement.lang = lang;
    window.document.body.innerHTML = renderFormHtml(form, embed, { registry, lang });
    window.fetch = fetchImpl as never;
    window.eval(FORMS_RUNTIME_JS);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await run(window, window.document.querySelector('form') as unknown as HTMLFormElement);
  } finally {
    await window.happyDOM.close();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => unknown) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}
const topError = (el: HTMLFormElement) => el.querySelector('.form-toplevel-error')!.textContent;
const submit = (window: Window, el: HTMLFormElement) => el.dispatchEvent(new window.Event('submit', { cancelable: true }) as never);

describe('formMessage', () => {
  it('answers in Swedish for sv site languages and in English otherwise', () => {
    expect(formMessage('too_fast', 'sv')).toBe('Vänta en stund och försök igen.');
    expect(formMessage('too_fast', 'sv-SE')).toBe('Vänta en stund och försök igen.');
    expect(formMessage('too_fast', 'SV')).toBe('Vänta en stund och försök igen.');
    expect(formMessage('too_fast', 'en')).toBe('Slow down and try again.');
    expect(formMessage('too_fast', 'de')).toBe('Slow down and try again.');
    expect(formMessage('too_fast', undefined)).toBe('Slow down and try again.');
  });
});

describe('form shell messages', () => {
  it('carries the fallback message in the site language', () => {
    expect(renderFormHtml(CONTACT, embed, { registry, lang: 'sv' })).toContain('data-msg-fail="Något gick fel — försök igen."');
    expect(renderFormHtml(CONTACT, embed, { registry, lang: 'en' })).toContain('data-msg-fail="Something went wrong — please try again."');
  });

  it('adds the remote-form messages only to remote-backed forms', () => {
    const sv = renderFormHtml(REMOTE, embed, { registry, lang: 'sv' });
    expect(sv).toContain('data-msg-loading="Vänta tills formuläret har laddats innan du skickar. Ladda om sidan om det inte laddas."');
    expect(sv).toContain('data-msg-expired="Länken gäller inte längre. Be om en ny länk."');
    expect(sv).toContain('data-msg-retry-hours="Försök igen om {n} timmar."');
    expect(renderFormHtml(REMOTE, embed, { registry, lang: 'en' })).toContain('data-msg-loading="Wait for the form to load before submitting. If loading failed, reload this page."');
    expect(renderFormHtml(CONTACT, embed, { registry, lang: 'sv' })).not.toContain('data-msg-loading');
  });
});

describe('forms runtime messages', () => {
  it('shows the fallback message in the site language when the response is not JSON', async () => {
    for (const [lang, text] of [['sv', 'Något gick fel — försök igen.'], ['en', 'Something went wrong — please try again.']]) {
      await withForm(CONTACT, lang!, 'https://site.example/', async () => new Response('<html>gateway</html>', { status: 502 }), async (window, el) => {
        submit(window, el);
        await until(() => topError(el));
        expect(topError(el)).toBe(text);
      });
    }
  });

  it('asks a visitor to wait for a remote form to load, in the site language', async () => {
    const pending: Fetch = () => new Promise(() => {});
    await withForm(REMOTE, 'sv', 'https://site.example/', pending, async (window, el) => {
      submit(window, el);
      await tick();
      expect(topError(el)).toBe('Vänta tills formuläret har laddats innan du skickar. Ladda om sidan om det inte laddas.');
    });
    await withForm(REMOTE, 'en', 'https://site.example/', pending, async (window, el) => {
      submit(window, el);
      await tick();
      expect(topError(el)).toBe('Wait for the form to load before submitting. If loading failed, reload this page.');
    });
  });

  it('names the wait of a limited remote form and the allowed work email domains', async () => {
    let retryAfter = 7200;
    const remote: Fetch = async (_url, init) => init?.method === 'POST'
      ? Response.json({ ok: false, error: 'Gränsen är nådd.', retry_after: retryAfter }, { status: 429 })
      : Response.json({ fields: [{ name: 'email', value: '', allowed_domains: ['acme.se', 'acme.com'] }] });
    await withForm(REMOTE, 'sv', 'https://site.example/', remote, async (window, el) => {
      await until(() => el.querySelector('#domain-email'));
      expect(el.querySelector('#domain-email')!.textContent).toBe('Använd en jobbadress på acme.se eller acme.com. Högst två länkar per profil på 24 timmar.');
      submit(window, el);
      await until(() => topError(el));
      expect(topError(el)).toBe('Gränsen är nådd. Försök igen om 2 timmar.');
      retryAfter = 1800;
      submit(window, el);
      await until(() => topError(el)?.endsWith('timme.'));
      expect(topError(el)).toBe('Gränsen är nådd. Försök igen om en timme.');
    });
    await withForm(REMOTE, 'en', 'https://site.example/', remote, async (window, el) => {
      await until(() => el.querySelector('#domain-email'));
      expect(el.querySelector('#domain-email')!.textContent).toBe('Use a work email on acme.se or acme.com. Two links per profile in 24 hours.');
      retryAfter = 7200;
      submit(window, el);
      await until(() => topError(el));
      expect(topError(el)).toBe('Gränsen är nådd. Try again in 2 hours.');
    });
  });
});

describe('campaign parameters', () => {
  const posted = async (url: string, form: Form = CONTACT) => {
    let body: FormData | undefined;
    await withForm(form, 'sv', url, async (_u, init) => { body = init?.body; return Response.json({ v: 1, ok: true, done: true }); }, async (window, el) => {
      submit(window, el);
      await until(() => body);
    });
    return body!;
  };

  it('fills hidden utm_* fields from the page URL and posts them', async () => {
    const body = await posted('https://site.example/kontakt/?utm_source=linkedin&utm_medium=social&ref=ad');
    expect(body.get('utm_source')).toBe('linkedin');
    expect(body.get('utm_medium')).toBe('social');
    // Only utm_* fields follow the URL; other hidden fields keep their value.
    expect(body.get('ref')).toBe('footer');
  });

  it("keeps a field's own value when the URL has no such parameter", async () => {
    const body = await posted('https://site.example/kontakt/?utm_source=%20%20');
    expect(body.get('utm_source')).toBe('');
    expect(body.get('utm_medium')).toBe('website');
  });

  it('caps a parameter at 255 characters', async () => {
    const body = await posted(`https://site.example/kontakt/?utm_source=${'x'.repeat(300)}`);
    expect(body.get('utm_source')).toBe('x'.repeat(255));
  });

  it('fills fields on later steps too', async () => {
    const steps: Form = {
      ...CONTACT,
      steps: [
        { id: 'one', blocks: [{ id: 'n', type: 'form/text', data: { name: 'name', label: 'Namn' } }] },
        { id: 'two', blocks: [{ id: 's', type: 'form/hidden', data: { name: 'utm_campaign', value: '' } }] },
      ],
    };
    const window = new Window({ url: 'https://site.example/?utm_campaign=var' });
    try {
      window.document.body.innerHTML = renderFormHtml(steps, embed, { registry, lang: 'sv' });
      window.eval(FORMS_RUNTIME_JS);
      window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
      expect((window.document.querySelector('input[name=utm_campaign]') as unknown as HTMLInputElement).value).toBe('var');
    } finally {
      await window.happyDOM.close();
    }
  });
});

describe('Extension runtime fallback', () => {
  it('says a component is unavailable in the page language', async () => {
    for (const [lang, text] of [['sv', 'Den här funktionen är inte tillgänglig just nu.'], ['en', 'This feature is temporarily unavailable.']]) {
      const window = new Window({ url: 'https://site.example/', settings: { disableIframePageLoading: true } });
      try {
        window.document.documentElement.lang = lang!;
        window.document.body.innerHTML = '<div data-tr-extension-installation="i" data-tr-extension-component="c"></div>';
        window.eval(buildExtensionRuntimeScript({
          runtime_version: '0.40.0', protocol_version: 3,
          installations: [{
            installation_id: 'i', extension_id: 'e', version: '1.0.0', public_config: {},
            components: [{ id: 'c', block_type_id: 'extension/c', label: 'C', render_mode: 'bundled_component', local_script_url: 'data:text/javascript,throw%201' }],
          }],
        } as never));
        window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
        await until(() => window.document.querySelector('.tr-extension-unavailable'));
        expect(window.document.querySelector('.tr-extension-unavailable')?.textContent).toBe(text);
      } finally {
        await window.happyDOM.close();
      }
    }
  });
});
