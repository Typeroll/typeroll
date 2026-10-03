// Campaign parameters through the real submit endpoint: the forms runtime
// fills hidden utm_* fields from the page URL, and the stored submission
// keeps them. Without the parameter the field's own value is sent.
import { Window } from 'happy-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, renderFormHtml, buildCoreBlockRegistry, FORMS_RUNTIME_JS } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

const FORM: Omit<Form, 'id'> = {
  name: 'Contact',
  actions: [],
  created_at: new Date().toISOString(),
  steps: [{ id: 'main', blocks: [
    { id: 'n', type: 'form/text', data: { name: 'name', label: 'Name' } },
    { id: 's', type: 'form/hidden', data: { name: 'utm_source', value: '' } },
    { id: 'c', type: 'form/hidden', data: { name: 'utm_campaign', value: '' } },
    { id: 'm', type: 'form/hidden', data: { name: 'utm_medium', value: 'website' } },
  ] }],
};

let ipCounter = 0;
const nextIp = () => `10.10.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'f'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', language: 'sv', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/contact`, FORM);
  const { signFormToken } = await import('../../lib/forms-signing');
  return { token: signFormToken(ORG, SITE, 'contact') };
}

async function submitThroughRuntime(pageUrl: string, token: string): Promise<Record<string, unknown>> {
  const { POST } = await import('../../pages/api/forms/submit');
  const window = new Window({ url: pageUrl });
  try {
    window.document.body.innerHTML = renderFormHtml(
      { id: 'contact', ...FORM } as Form,
      { submit_url: 'https://forms.example.test/api/forms/submit', submit_token: token },
      { registry: buildCoreBlockRegistry(), lang: 'sv' },
    );
    window.fetch = (async (_url: unknown, options?: { body?: FormData }) => {
      const fd = new FormData();
      for (const [k, v] of options!.body!.entries()) fd.append(k, String(v));
      const res = await POST({ request: new Request('http://localhost/api/forms/submit', { method: 'POST', headers: { 'x-forwarded-for': nextIp(), accept: 'application/json' }, body: fd }) } as never) as Response;
      return new Response(await res.text(), { status: res.status });
    }) as never;
    window.eval(FORMS_RUNTIME_JS);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const form = window.document.querySelector('form')!;
    (form.querySelector('input[name=name]') as unknown as { value: string }).value = 'Ada';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    for (let i = 0; i < 50 && !window.document.querySelector('.form-done'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(window.document.querySelector('.form-done')?.textContent).toBe('Tack!');
  } finally {
    await window.happyDOM.close();
  }
  const { getStore } = await import('../../lib/datastore');
  const subs = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
  expect(subs).toHaveLength(1);
  return subs[0].data as Record<string, unknown>;
}

describe('utm_* hidden fields', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('stores the campaign parameters of the page URL', async () => {
    const { token } = await setup();
    const data = await submitThroughRuntime('https://site.example.test/kontakt/?utm_source=linkedin&utm_campaign=v%C3%A5r-2026&utm_medium=social', token);
    expect(data).toEqual({ name: 'Ada', utm_source: 'linkedin', utm_campaign: 'vår-2026', utm_medium: 'social' });
  });

  it("keeps each field's own value when the URL has no parameter for it", async () => {
    const { token } = await setup();
    const data = await submitThroughRuntime('https://site.example.test/kontakt/', token);
    expect(data).toEqual({ name: 'Ada', utm_source: '', utm_campaign: '', utm_medium: 'website' });
  });
});
