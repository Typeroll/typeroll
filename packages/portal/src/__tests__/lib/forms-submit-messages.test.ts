// Visitor-facing messages of the submit endpoint follow the site's language
// (sv or en) once the token names the site, and the request's
// Accept-Language before that. Machine codes never change.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

const FORM: Omit<Form, 'id'> = {
  name: 'Lead',
  actions: [],
  created_at: new Date().toISOString(),
  steps: [
    { id: 'one', blocks: [{ id: 'n', type: 'form/text', data: { name: 'name', label: 'Name', required: true } }] },
    { id: 'two', blocks: [{ id: 'm', type: 'form/textarea', data: { name: 'message', label: 'Message' } }] },
  ],
};

let ipCounter = 0;
const nextIp = () => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function setup(language?: string) {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'e'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', ...(language ? { language } : {}), created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/lead`, FORM);
  const { signFormToken, signFormState } = await import('../../lib/forms-signing');
  return {
    token: signFormToken(ORG, SITE, 'lead'),
    // A continuation issued just now: the next step arrives too fast.
    freshState: signFormState({ orgId: ORG, siteId: SITE, formId: 'lead', submissionId: 'x', step: 'one' }),
  };
}

async function submit(body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('../../pages/api/forms/submit');
  return POST({ request: new Request('http://localhost/api/forms/submit', { method: 'POST', headers: { 'x-forwarded-for': nextIp(), ...headers }, body }) } as never) as Promise<Response>;
}

const runtimePost = (fields: Record<string, string>) => submit(new URLSearchParams({ _protocol: '1', ...fields }), { accept: 'application/json' });

describe('submit endpoint messages', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('answers too_fast and bad_state in Swedish on a Swedish site', async () => {
    const { token, freshState } = await setup('sv');
    const fast = await runtimePost({ _token: token, _state: freshState, message: 'Hej' });
    expect(fast.status).toBe(429);
    expect((await fast.json()).errors).toEqual([{ field: null, code: 'too_fast', message: 'Vänta en stund och försök igen.' }]);

    const expired = await runtimePost({ _token: token, _state: 'forged', message: 'Hej' });
    expect(expired.status).toBe(403);
    expect((await expired.json()).errors).toEqual([{ field: null, code: 'bad_state', message: 'Sessionen har gått ut — ladda om sidan.' }]);
  });

  it('keeps the English messages on an English site and on a site without a language', async () => {
    for (const language of ['en', undefined]) {
      const { token, freshState } = await setup(language);
      const fast = await runtimePost({ _token: token, _state: freshState, message: 'Hi' });
      expect((await fast.json()).errors).toEqual([{ field: null, code: 'too_fast', message: 'Slow down and try again.' }]);
    }
  });

  it('follows the site language, not the visitor, once the token names the site', async () => {
    const { token, freshState } = await setup('sv');
    const res = await submit(new URLSearchParams({ _protocol: '1', _token: token, _state: freshState }), { accept: 'application/json', 'accept-language': 'en-US,en;q=0.9' });
    expect((await res.json()).errors[0].message).toBe('Vänta en stund och försök igen.');
  });

  it('renders the no-JS error and confirmation pages in the site language', async () => {
    const { token } = await setup('sv');
    const invalid = await submit(new URLSearchParams({ _token: token, name: '' }));
    expect(invalid.status).toBe(400);
    const errorPage = await invalid.text();
    expect(errorPage).toContain('<html lang="sv">');
    expect(errorPage).toContain('<title>Inte skickat</title>');
    expect(errorPage).toContain('Name måste fyllas i');

    const ok = await submit(new URLSearchParams({ _token: token, name: 'Ada' }));
    expect(ok.status).toBe(200);
    const okPage = await ok.text();
    expect(okPage).toContain('<title>Skickat</title>');
    expect(okPage).toContain('Tack!');
  });

  it('answers the honeypot in the site language', async () => {
    const { token } = await setup('sv');
    const res = await runtimePost({ _token: token, _hp: 'bot', name: 'Bot' });
    expect(await res.json()).toEqual({ ok: true, done: true, message: 'Tack!' });
  });

  it("uses the request's Accept-Language before the token is verified", async () => {
    await setup('sv');
    const sv = await submit(JSON.stringify({ token: 'orgone.mysite.lead.forged', data: {} }), { 'content-type': 'application/json', 'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8' });
    expect(sv.status).toBe(403);
    expect(await sv.json()).toEqual({ error: 'Formuläret är inte längre giltigt. Ladda om sidan och försök igen.' });

    const en = await submit(JSON.stringify({ token: 'orgone.mysite.lead.forged', data: {} }), { 'content-type': 'application/json' });
    expect(await en.json()).toEqual({ error: 'Invalid token' });

    const missing = await submit(new URLSearchParams({ name: 'Ada' }), { 'accept-language': 'sv' });
    expect(missing.status).toBe(400);
    const page = await missing.text();
    expect(page).toContain('<html lang="sv">');
    expect(page).toContain('Formuläret saknar uppgifter. Ladda om sidan och försök igen.');
  });

  it('reads the first Accept-Language choice only', async () => {
    const { requestLanguage } = await import('../../pages/api/forms/submit');
    expect(requestLanguage('sv-SE,sv;q=0.9')).toBe('sv');
    expect(requestLanguage('SV')).toBe('sv');
    expect(requestLanguage('en-GB,sv;q=0.8')).toBe('en');
    expect(requestLanguage('')).toBe('en');
    expect(requestLanguage(null)).toBe('en');
  });
});

describe('pre-submit check failures', () => {
  it('report a crashed check in the site language', async () => {
    const { actionRegistry, runBeforeActions, _resetActionRegistryForTests } = await import('../../lib/forms/actions');
    const registry = await actionRegistry();
    registry.set('test_crash', { type: 'test_crash', label: 'Crash', before: async () => { throw new Error('down'); } } as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const form = { actions: [{ type: 'test_crash' }] } as never;
      const ctx = { orgId: ORG, siteId: SITE, data: {}, subject: { kind: 'submission' } } as never;
      expect(await runBeforeActions(form, ctx, 'sv')).toEqual({ ok: false, reason: 'Det gick inte att ta emot svaret. Försök igen.' });
      expect(await runBeforeActions(form, ctx, 'en')).toEqual({ ok: false, reason: 'This submission could not be processed. Please try again.' });
    } finally {
      error.mockRestore();
      _resetActionRegistryForTests();
    }
  });
});
