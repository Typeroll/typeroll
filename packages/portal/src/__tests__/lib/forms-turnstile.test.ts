// Cloudflare Turnstile on site forms: the secret is stored encrypted and
// never returned, a form starts requiring Turnstile only after its pages send
// a verified answer, a refused answer stores nothing, continuation steps need
// no answer, Cloudflare outages do not block visitors, and builds receive
// only the public site key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

process.env.AUTH_TRUST_PROXY_HOPS = '1';

const ORG = 'orgone';
const SITE = 'mysite';
const SITE_KEY = '0x4AAAAAAAtestsitekey';
const SECRET = '0x4AAAAAAAtestsecretkey000000';

const FORM: Omit<Form, 'id'> = {
  name: 'Lead',
  actions: [],
  created_at: new Date().toISOString(),
  steps: [
    { id: 'one', blocks: [{ id: 'n', type: 'form/text', data: { name: 'name', label: 'Name', required: true } }] },
    { id: 'two', blocks: [{ id: 'e', type: 'form/text', data: { name: 'note', label: 'Note' } }] },
  ],
};

let ipCounter = 0;
const nextIp = () => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/** Cloudflare's siteverify, answering by the posted response. */
function cloudflare(answers: Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const body = init?.body as URLSearchParams;
    calls.push(body);
    const answer = answers[body.get('response') ?? ''] ?? answers['*'];
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'h'.repeat(48);
  process.env.INTEGRATIONS_SECRET_KEY = 'k'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/lead`, FORM);
  const { signFormToken } = await import('../../lib/forms-signing');
  return signFormToken(ORG, SITE, 'lead');
}

async function enable() {
  cloudflare({ '*': { success: false, 'error-codes': ['invalid-input-response'] } });
  const { saveFormSpamProtection } = await import('../../lib/forms/turnstile');
  return saveFormSpamProtection(ORG, SITE, { provider: 'turnstile', site_key: SITE_KEY, secret_key: SECRET });
}

async function post(token: string, data: Record<string, unknown>) {
  const { POST } = await import('../../pages/api/forms/submit');
  const request = new Request('http://localhost/api/forms/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ token, data: { _protocol: '1', ...data } }),
  });
  const response = await (POST({ request } as never) as Promise<Response>);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function submissions() {
  const { getStore } = await import('../../lib/datastore');
  return getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
}

describe('form Turnstile', () => {
  beforeEach(async () => { await resetDatastore(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('stores the secret encrypted and returns it only masked', async () => {
    await setup();
    const saved = await enable();
    expect(saved).toMatchObject({ provider: 'turnstile', site_key: SITE_KEY, secret_key: { set: true }, enforced_forms: [] });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    const { getStore } = await import('../../lib/datastore');
    const site = await getStore().getDoc<Record<string, any>>(paths.site(ORG, SITE));
    expect(site?.form_turnstile.site_key).toBe(SITE_KEY);
    expect(site?.form_turnstile.secret_encrypted).not.toContain(SECRET);
  });

  it('refuses a secret Cloudflare does not recognize', async () => {
    await setup();
    cloudflare({ '*': { success: false, 'error-codes': ['invalid-input-secret'] } });
    const { saveFormSpamProtection } = await import('../../lib/forms/turnstile');
    await expect(saveFormSpamProtection(ORG, SITE, { provider: 'turnstile', site_key: SITE_KEY, secret_key: SECRET }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_turnstile_secret' });
  });

  it('keeps accepting forms without an answer until their pages send a valid one, then requires it', async () => {
    const token = await setup();
    await enable();
    cloudflare({ good: { success: true }, '*': { success: false, 'error-codes': ['invalid-input-response'] } });

    // Pages published before the widget: no answer, still accepted.
    expect((await post(token, { name: 'Old page' })).status).toBe(200);
    // Republished pages send a verified answer; it is not stored as an answer.
    expect((await post(token, { name: 'New page', 'cf-turnstile-response': 'good' })).status).toBe(200);
    const stored = await submissions();
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain('cf-turnstile-response');

    const { readFormSpamProtection } = await import('../../lib/forms/turnstile');
    expect((await readFormSpamProtection(ORG, SITE)).enforced_forms.map(entry => entry.form_id)).toEqual(['lead']);
    const missing = await post(token, { name: 'Bot' });
    expect(missing.status).toBe(403);
    expect(missing.body.errors[0].code).toBe('spam_check_required');
    const forged = await post(token, { name: 'Bot', 'cf-turnstile-response': 'forged' });
    expect(forged.status).toBe(403);
    expect(forged.body.errors[0].code).toBe('spam_check_failed');
    expect(await submissions()).toHaveLength(2);
  });

  it('refuses an invalid answer even before the form requires one', async () => {
    const token = await setup();
    await enable();
    cloudflare({ '*': { success: false, 'error-codes': ['timeout-or-duplicate'] } });
    expect((await post(token, { name: 'Bot', 'cf-turnstile-response': 'reused' })).body.errors[0].code).toBe('spam_check_failed');
    expect(await submissions()).toHaveLength(0);
  });

  it('accepts the visitor when Cloudflare cannot be reached, and does not start requiring Turnstile', async () => {
    const token = await setup();
    await enable();
    cloudflare({ '*': new Error('offline') });
    expect((await post(token, { name: 'Ada', 'cf-turnstile-response': 'good' })).status).toBe(200);
    const { readFormSpamProtection } = await import('../../lib/forms/turnstile');
    expect((await readFormSpamProtection(ORG, SITE)).enforced_forms).toEqual([]);
  });

  it('checks only the first step of a multi-step form', async () => {
    const token = await setup();
    await enable();
    const calls = cloudflare({ good: { success: true } });
    const first = await post(token, { name: 'Ada', 'cf-turnstile-response': 'good' });
    expect(first.status).toBe(200);
    expect(first.body.state).toBeTruthy();
    expect(calls).toHaveLength(1);
    // The signed continuation carries the visitor; the step interval check still applies.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    try {
      const second = await post(token, { note: 'Hi', _state: first.body.state });
      expect(second.status).toBe(200);
      expect(calls).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('starts over in monitor mode with a new site key and stops checking when removed', async () => {
    const token = await setup();
    await enable();
    cloudflare({ good: { success: true } });
    await post(token, { name: 'Ada', 'cf-turnstile-response': 'good' });
    expect((await post(token, { name: 'Bot' })).status).toBe(403);

    cloudflare({ '*': { success: false, 'error-codes': ['invalid-input-response'] } });
    const { saveFormSpamProtection, removeFormSpamProtection } = await import('../../lib/forms/turnstile');
    await saveFormSpamProtection(ORG, SITE, { provider: 'turnstile', site_key: '0x4AAAAAAAnewsitekey', secret_key: SECRET });
    expect((await post(token, { name: 'Old page' })).status).toBe(200);

    await removeFormSpamProtection(ORG, SITE);
    expect((await post(token, { name: 'Ada', 'cf-turnstile-response': 'anything' })).status).toBe(200);
  });

  it('gives builds the public site key only', async () => {
    await setup();
    await enable();
    process.env.FORMS_PUBLIC_URL = 'https://forms.example.invalid';
    const { publicationRuntime } = await import('../../lib/publishing/runtime-projection');
    const runtime = await publicationRuntime(ORG, SITE);
    expect(runtime.forms[0]).toMatchObject({ turnstile_site_key: SITE_KEY });
    expect(JSON.stringify(runtime)).not.toContain('secret_encrypted');
    delete process.env.FORMS_PUBLIC_URL;
  });
});
