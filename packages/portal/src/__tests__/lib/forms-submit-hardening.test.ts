// Abuse hardening of the public submit endpoint: the no-JS confirmation page
// is sandboxed, the body limit holds for chunked bodies, rate limits follow
// the trusted proxy hop, a solved proof of work buys one post, answers are
// primitives within length limits, and app-owned forms take no submissions.
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

process.env.AUTH_TRUST_PROXY_HOPS = '1';

const ORG = 'orgone';
const SITE = 'mysite';

const FORM: Omit<Form, 'id'> = {
  name: 'Lead',
  actions: [],
  created_at: new Date().toISOString(),
  success_message: '<p>Thanks!</p><img src=x onerror="alert(1)">',
  steps: [{ id: 'one', blocks: [
    { id: 'n', type: 'form/text', data: { name: 'name', label: 'Name', required: true } },
    { id: 'c', type: 'form/checkbox_group', data: { name: 'topics', label: 'Topics', options: ['a', 'b'] } },
  ] }],
};

let ipCounter = 0;
const nextIp = () => `10.7.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function setup(form: Omit<Form, 'id'> = FORM) {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = 'h'.repeat(48);
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/lead`, form);
  const { signFormToken } = await import('../../lib/forms-signing');
  return signFormToken(ORG, SITE, 'lead');
}

async function post(request: Request, clientAddress?: string): Promise<Response> {
  const { POST } = await import('../../pages/api/forms/submit');
  return POST({ request, clientAddress } as never) as Promise<Response>;
}

function jsonRequest(body: unknown, ip = nextIp()): Request {
  return new Request('http://localhost/api/forms/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

async function storedSubmissions() {
  const { getStore } = await import('../../lib/datastore');
  return getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
}

function solvePow(token: string, bits = 15): string {
  const bucket = Math.floor(Date.now() / 600_000);
  for (let nonce = 0; ; nonce++) {
    const digest = crypto.createHash('sha256').update(`${token}.${bucket}.${nonce}`).digest();
    let zeros = 0;
    for (const byte of digest) {
      if (byte === 0) { zeros += 8; continue; }
      zeros += Math.clz32(byte) - 24;
      break;
    }
    if (zeros >= bits) return `${bucket}.${nonce}`;
  }
}

describe('submit endpoint hardening', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('serves the no-JS confirmation page sandboxed, without scripts or same-origin access', async () => {
    const token = await setup();
    const res = await post(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp(), referer: 'https://www.example.com/contact/' },
      body: new URLSearchParams({ _token: token, name: 'Ada' }),
    }));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/(^|;\s*)sandbox\b/);
    expect(csp).not.toMatch(/allow-scripts|allow-same-origin|allow-forms/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain('href="https://www.example.com/contact/"');
  });

  it('sandboxes the no-JS error page too', async () => {
    await setup();
    const res = await post(new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp() },
      body: new URLSearchParams({ _token: 'forged' }),
    }));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-security-policy')).toMatch(/(^|;\s*)sandbox\b/);
  });

  it('refuses a chunked body over 64 KiB that declares no length', async () => {
    const token = await setup();
    const big = JSON.stringify({ token, data: { name: 'x'.repeat(70 * 1024) } });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(big);
        for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.slice(i, i + 8192));
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/forms/submit', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() }, body: stream, duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const res = await post(request);
    expect(res.status).toBe(413);
    expect(await storedSubmissions()).toHaveLength(0);
  });

  it('rate limits by the trusted hop, not a client-chosen leftmost X-Forwarded-For', async () => {
    const token = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // A fresh spoofed client entry each time, one real proxy-appended
      // address. Without a proof of work the budget is five posts.
      const res = await post(jsonRequest({ token, data: { name: 'Ada', _hp: 'bot' } }, `198.51.100.${i}, 203.0.113.9`));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('uses the client address for rate limiting only and never stores it', async () => {
    const token = await setup();
    const res = await post(jsonRequest({ token, data: { name: 'Ada' } }, '6.6.6.6, 203.0.113.44'));
    expect(res.status).toBe(200);
    const [saved] = await storedSubmissions();
    expect(saved).not.toHaveProperty('submitted_from_ip');
    expect(JSON.stringify(saved)).not.toContain('203.0.113.44');
  });

  it('accepts the same proof of work from different visitors of one form', async () => {
    // Published runtimes compute the same nonce for every visitor of a form,
    // so a proof must stay valid for more than one post.
    const token = await setup();
    const pow = solvePow(token);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await post(jsonRequest({ token, data: { name: `Ada ${i}`, _pow: pow } }, '203.0.113.77'));
      statuses.push(res.status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('refuses non-primitive and oversized answers before storage', async () => {
    const token = await setup();
    const object = await post(jsonRequest({ token, data: { name: { toString: 'x' } } }));
    expect(object.status).toBe(400);
    const nested = await post(jsonRequest({ token, data: { name: 'Ada', topics: [['a']] } }));
    expect(nested.status).toBe(400);
    const long = await post(jsonRequest({ token, data: { name: 'x'.repeat(10_001) } }));
    expect(long.status).toBe(400);
    expect((await long.json()).errors?.[0] ?? '').toBeTruthy();
    expect(await storedSubmissions()).toHaveLength(0);

    const ok = await post(jsonRequest({ token, data: { name: 'x'.repeat(10_000), topics: ['a', 'b'] } }));
    expect(ok.status).toBe(200);
    expect(await storedSubmissions()).toHaveLength(1);
  });

  it('refuses submissions to forms owned by an app or Extension installation', async () => {
    for (const target of [{ installation_id: 'inst1', path: '/intake' }, { app: 'directory' }]) {
      const token = await setup({ ...FORM, target } as Omit<Form, 'id'>);
      const res = await post(jsonRequest({ token, data: { name: 'Ada' } }));
      expect(res.status).toBe(404);
      expect(await storedSubmissions()).toHaveLength(0);
    }
  });
});
