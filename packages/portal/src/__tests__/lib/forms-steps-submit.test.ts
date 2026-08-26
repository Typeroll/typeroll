// Forms 2.0 steps-mode through the real submit endpoint: continuation
// tokens, partial saves, per-step validation, PoW + anti-abuse seams,
// and the no-JS fallback. Uses tmp fixtures — no datastore mocks.
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const SECRET = 'a'.repeat(48);

const STEPS_FORM: Omit<Form, 'id'> = {
  name: 'Ansökan',
  actions: [],
  success_message: 'Tack!',
  created_at: new Date().toISOString(),
  steps: [
    { id: 'steg1', blocks: [
      { id: 'b1', type: 'form/text', data: { name: 'foretag', label: 'Företag', required: true } },
    ] },
    { id: 'steg2', blocks: [
      { id: 'b2', type: 'form/email', data: { name: 'epost', label: 'E-post', required: true } },
    ] },
  ],
};

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = SECRET;
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'S', language: 'sv', created_at: new Date().toISOString() });
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/ansokan`, STEPS_FORM);
  const { signFormToken } = await import('../../lib/forms-signing');
  return { token: signFormToken(ORG, SITE, 'ansokan') };
}

async function post(body: Record<string, string>): Promise<Response> {
  const { POST } = await import('../../pages/api/forms/submit');
  const fd = new URLSearchParams(body);
  const req = new Request('http://localhost/api/forms/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` },
    body: fd.toString(),
  });
  return POST({ request: req } as never) as Promise<Response>;
}

describe('steps-mode submit flow', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('step 1 → validation errors carry field + code + Swedish message', async () => {
    const { token } = await setup();
    const res = await post({ _token: token, _protocol: '1', foretag: '' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.errors[0]).toMatchObject({ field: 'foretag', code: 'required' });
    expect(body.errors[0].message).toContain('måste fyllas i');
  });

  it('full funnel: partial save with TTL → continuation → complete', async () => {
    const { token } = await setup();
    const r1 = await post({ _token: token, _protocol: '1', foretag: 'AB Exempel' });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1).toMatchObject({ v: 1, ok: true, next_step: 'steg2' });
    expect(typeof b1.state).toBe('string');

    const { getStore } = await import('../../lib/datastore');
    const subs1 = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
    expect(subs1.length).toBe(1);
    expect(subs1[0].status).toBe('partial');
    expect(subs1[0].step).toBe('steg1');
    expect(typeof subs1[0].expires_at).toBe('string');
    expect((subs1[0].data as Record<string, unknown>).foretag).toBe('AB Exempel');

    // Continuation too fast → throttled (bot signature).
    const fast = await post({ _token: token, _protocol: '1', _state: b1.state, epost: 'a@b.se' });
    expect(fast.status).toBe(429);

    // Respect the human-speed floor, then finish.
    const { verifyFormState, signFormState } = await import('../../lib/forms-signing');
    const st = verifyFormState(b1.state)!;
    const aged = signFormState({ ...st, iat: Date.now() - 5000 });
    const r2 = await post({ _token: token, _protocol: '1', _state: aged, epost: 'a@b.se' });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2).toMatchObject({ v: 1, ok: true, done: true });

    const subs2 = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
    expect(subs2.length).toBe(1);
    expect(subs2[0].status).toBe('complete');
    expect(subs2[0].expires_at).toBeNull();
    const data = subs2[0].data as Record<string, unknown>;
    expect(data.foretag).toBe('AB Exempel');
    expect(data.epost).toBe('a@b.se');
  });

  it('tampered state is rejected; undeclared fields never reach storage', async () => {
    const { token } = await setup();
    const bad = await post({ _token: token, _protocol: '1', _state: 'v1.evil.sig', epost: 'a@b.se' });
    expect(bad.status).toBe(403);

    const r1 = await post({ _token: token, _protocol: '1', foretag: 'AB', hacker_field: 'x' });
    expect(r1.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    const subs = await getStore().listDocs<Record<string, unknown>>(paths.submissions(ORG, SITE));
    expect((subs[0].data as Record<string, unknown>).hacker_field).toBeUndefined();
  });

  it('runs pre-submit actions before storage and surfaces a veto', async () => {
    const { token } = await setup();
    const { actionRegistry, _resetActionRegistryForTests } = await import('../../lib/forms/actions');
    _resetActionRegistryForTests();
    (await actionRegistry()).set('test/veto', {
      type: 'test/veto',
      label: 'Test veto',
      before: async () => ({ reject: 'Registration is closed.' }),
      run: async () => {},
    });
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/ansokan`, {
      ...STEPS_FORM,
      actions: [{ type: 'test/veto', config: {} }],
    });

    const res = await post({ _token: token, _protocol: '1', foretag: 'AB Exempel' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      ok: false,
      errors: [{ field: null, code: 'action_rejected', message: 'Registration is closed.' }],
    });
    expect(await getStore().listDocs(paths.submissions(ORG, SITE))).toHaveLength(0);
    _resetActionRegistryForTests();
  });

  it('no-JS POST (no protocol flag) stores step-1 partial and returns the HTML page', async () => {
    const { token } = await setup();
    const { POST } = await import('../../pages/api/forms/submit');
    const req = new Request('http://localhost/api/forms/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.9.9.9' },
      body: new URLSearchParams({ _token: token, foretag: 'AB' }).toString(),
    });
    const res = (await POST({ request: req } as never)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Tack!');
  });
});

describe('proof-of-work verification', () => {
  it('accepts a correctly mined nonce and rejects stale buckets', async () => {
    process.env.FORMS_HMAC_SECRET = SECRET;
    const { verifyPow } = await import('../../lib/forms-signing');
    const crypto = await import('node:crypto');
    const token = 'tok';
    const bucket = Math.floor(Date.now() / 600_000);
    const mine = (b: number, bits: number) => {
      for (let nonce = 0; ; nonce++) {
        const d = crypto.createHash('sha256').update(`${token}.${b}.${nonce}`).digest();
        let zeros = 0;
        for (const byte of d) { if (byte === 0) { zeros += 8; continue; } let x = byte; while ((x & 0x80) === 0) { zeros++; x = (x << 1) & 0xff; } break; }
        if (zeros >= bits) return nonce;
      }
    };
    const nonce = mine(bucket, 8);
    expect(verifyPow(token, `${bucket}.${nonce}`, 8)).toBe(true);
    expect(verifyPow(token, `${bucket}.${nonce + 999999}`, 30)).toBe(false);
    const old = bucket - 5;
    expect(verifyPow(token, `${old}.${mine(old, 8)}`, 8)).toBe(false);
  });
});
