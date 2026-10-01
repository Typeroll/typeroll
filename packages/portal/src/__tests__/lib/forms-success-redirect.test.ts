// Completion behaviour for visitors without JavaScript: an optional
// success_redirect_url sends them on (resolved against the page they came
// from, since the submit endpoint is another origin), and success_message is
// rendered as sanitized rich text like the scripted path.
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(form: Partial<Form>) {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'a'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', language: 'sv', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/kontakt`, {
    name: 'Kontakt', actions: [], created_at: new Date().toISOString(),
    steps: [{ id: 'main', blocks: [{ id: 'f', type: 'form/text', data: { name: 'namn', label: 'Namn', required: true } }] }],
    ...form,
  } satisfies Omit<Form, 'id'>);
  const { signFormToken } = await import('../../lib/forms-signing');
  return signFormToken(ORG, SITE, 'kontakt');
}

async function postNoScript(token: string, referer?: string): Promise<Response> {
  const { POST } = await import('../../pages/api/forms/submit');
  const req = new Request('http://localhost/api/forms/submit', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': `10.1.0.${Math.floor(Math.random() * 250)}`,
      ...(referer ? { referer } : {}),
    },
    body: new URLSearchParams({ _token: token, namn: 'Anna' }).toString(),
  });
  return POST({ request: req } as never) as Promise<Response>;
}

describe('form completion without JavaScript', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('redirects to a root-relative target on the originating site', async () => {
    const token = await setup({ success_redirect_url: '/boka/' });
    const res = await postNoScript(token, 'https://www.example.se/ai-partner/');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://www.example.se/boka/');
  });

  it('redirects to an absolute target without needing a referer', async () => {
    const token = await setup({ success_redirect_url: 'https://cal.com/example/intro' });
    const res = await postNoScript(token);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://cal.com/example/intro');
  });

  it('ignores unsafe stored targets and shows the sanitized success message', async () => {
    const token = await setup({
      success_redirect_url: 'javascript:alert(1)',
      success_message: '<p><strong>Tack!</strong> <a href="https://cal.com/example">Boka tid</a></p><script>alert(1)</script>',
    });
    const res = await postNoScript(token, 'https://www.example.se/ai-partner/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<strong>Tack!</strong>');
    expect(html).toContain('href="https://cal.com/example"');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('falls back to the confirmation page for a relative target without a referer', async () => {
    const token = await setup({ success_redirect_url: '/boka/', success_message: 'Tack!' });
    const res = await postNoScript(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Tack!');
  });
});

describe('success_redirect_url on the forms API', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('rejects unsafe values and stores safe ones', async () => {
    await setup({});
    const { createApiKey } = await import('../../lib/api-keys');
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version(ORG, SITE, 'main'), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
    const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin' });
    const { PATCH } = await import('../../pages/api/v1/sites/[siteId]/forms/[formId]');
    const call = (body: unknown) => PATCH({
      request: new Request(`http://localhost/api/v1/sites/${SITE}/forms/kontakt`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      params: { siteId: SITE, formId: 'kontakt' }, cookies: { get: () => undefined }, locals: {},
    } as never) as Promise<Response>;

    for (const bad of ['javascript:alert(1)', '//evil.example/x', 'data:text/html,x']) {
      expect((await call({ success_redirect_url: bad })).status).toBe(400);
    }
    expect((await call({ success_redirect_url: 'https://cal.com/example/intro' })).status).toBe(200);
    const stored = await getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/kontakt`);
    expect(stored?.success_redirect_url).toBe('https://cal.com/example/intro');
    expect((await call({ success_redirect_url: '' })).status).toBe(200);
    expect((await getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/kontakt`))?.success_redirect_url).toBe('');
  });
});
