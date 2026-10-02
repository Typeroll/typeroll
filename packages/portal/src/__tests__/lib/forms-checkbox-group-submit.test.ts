// Checkbox groups through the real submit endpoint. A form post repeats the
// group's key once per ticked box; the stored answer must be the list of
// every ticked value — never just the last one — for the no-JS post and for
// the forms runtime, which posts the same FormData as multipart.
import { Window } from 'happy-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, renderFormHtml, buildCoreBlockRegistry, FORMS_RUNTIME_JS } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const SECRET = 'b'.repeat(48);

const FORM: Omit<Form, 'id'> = {
  name: 'Interests',
  actions: [],
  success_message: 'Thanks!',
  created_at: new Date().toISOString(),
  steps: [{ id: 'main', blocks: [
    { id: 'n', type: 'form/text', data: { name: 'name', label: 'Name' } },
    { id: 'g', type: 'form/checkbox_group', data: { name: 'interests', label: 'Interests', choices: [
      { value: 'seo', label: 'SEO' }, { value: 'ads', label: 'Ads' }, { value: 'web', label: 'Web' },
    ] } },
  ] }],
};

let ipCounter = 0;
const nextIp = () => `10.7.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = SECRET;
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/interests`, FORM);
  const { signFormToken } = await import('../../lib/forms-signing');
  return { token: signFormToken(ORG, SITE, 'interests') };
}

async function submit(body: string | URLSearchParams | FormData, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('../../pages/api/forms/submit');
  const req = new Request('http://localhost/api/forms/submit', {
    method: 'POST',
    headers: { 'x-forwarded-for': nextIp(), ...headers },
    body,
  });
  return POST({ request: req } as never) as Promise<Response>;
}

async function storedData(): Promise<Record<string, unknown>> {
  const { getStore } = await import('../../lib/datastore');
  const subs = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
  expect(subs).toHaveLength(1);
  return subs[0].data as Record<string, unknown>;
}

describe('checkbox group submissions', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('no-JS post with two ticked boxes stores both values', async () => {
    const { token } = await setup();
    const body = new URLSearchParams([['_token', token], ['name', 'Ada'], ['interests', 'seo'], ['interests', 'web']]);
    const res = await submit(body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await storedData()).toEqual({ name: 'Ada', interests: ['seo', 'web'] });
  });

  it('no-JS post with one ticked box stores a one-item list', async () => {
    const { token } = await setup();
    const res = await submit(new URLSearchParams([['_token', token], ['interests', 'ads']]));
    expect(res.status).toBe(200);
    expect((await storedData()).interests).toEqual(['ads']);
  });

  it('no-JS post with nothing ticked stores an empty list', async () => {
    const { token } = await setup();
    const res = await submit(new URLSearchParams([['_token', token], ['name', 'Ada']]));
    expect(res.status).toBe(200);
    expect(await storedData()).toEqual({ name: 'Ada', interests: [] });
  });

  it('JSON data with a single string for a group stores a list', async () => {
    const { token } = await setup();
    const res = await submit(
      JSON.stringify({ token, data: { interests: 'seo' } }),
      { 'content-type': 'application/json' },
    );
    expect(res.status).toBe(200);
    expect((await storedData()).interests).toEqual(['seo']);
  });

  it('forms runtime post with two ticked boxes stores both values', async () => {
    const { token } = await setup();
    const window = new Window({ url: 'https://site.example.test/contact' });
    try {
      window.document.body.innerHTML = renderFormHtml(
        { id: 'interests', ...FORM } as Form,
        { submit_url: 'https://forms.example.test/api/forms/submit', submit_token: token },
        { registry: buildCoreBlockRegistry() },
      );
      const posted: Array<[string, string]>[] = [];
      window.fetch = (async (_url: unknown, options?: { method?: string; body?: FormData }) => {
        const entries = Array.from(options!.body!.entries(), ([k, v]) => [k, String(v)] as [string, string]);
        posted.push(entries);
        // Hand the runtime's exact wire entries to the real endpoint.
        const fd = new FormData();
        for (const [k, v] of entries) fd.append(k, v);
        const res = await submit(fd, { accept: 'application/json' });
        return new Response(await res.text(), { status: res.status });
      }) as never;
      window.eval(FORMS_RUNTIME_JS);
      window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
      const form = window.document.querySelector('form')!;
      for (const value of ['seo', 'ads']) (form.querySelector(`input[name=interests][value=${value}]`) as unknown as { checked: boolean }).checked = true;
      form.dispatchEvent(new window.Event('submit', { cancelable: true }));
      for (let i = 0; i < 50 && !window.document.querySelector('.form-done'); i++) await new Promise((r) => setTimeout(r, 10));

      expect(posted).toHaveLength(1);
      expect(posted[0].filter(([k]) => k === 'interests').map(([, v]) => v)).toEqual(['seo', 'ads']);
      expect(posted[0]).toContainEqual(['_protocol', '1']);
      expect(window.document.querySelector('.form-done')).toBeTruthy();
      expect((await storedData()).interests).toEqual(['seo', 'ads']);
    } finally {
      await window.happyDOM.close();
    }
  });
});
