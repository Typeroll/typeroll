// The submit handler fires a form's `email` actions after a submission is
// stored, using the site's configured connector. A missing connector or a
// failed send must never break the submission.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { Site, SiteIntegrations } from '@typeroll/shared';

const sendMock = vi.fn();
vi.mock('../../lib/email', () => ({
  sendViaConnector: (...args: unknown[]) => sendMock(...args),
}));

const ORG = 'orgone';
const SITE = 'mysite';
const SECRET = 'test-secret-test-secret-test-secret-1234';

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  process.env.FORMS_HMAC_SECRET = SECRET;
  process.env.PORTAL_PUBLIC_URL = 'https://portal.example.com';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
}

async function seedFormWithEmailAction() {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.forms(ORG, SITE)}/kontakt`, {
    name: 'Kontakt',
    steps: [{ id: 'main', blocks: [
      { id: 'f-email', type: 'form/email', data: { name: 'email', label: 'E-post', required: true } },
      { id: 'f-message', type: 'form/textarea', data: { name: 'message', label: 'Meddelande' } },
    ] }],
    actions: [
      { type: 'email', config: { to: 'admin@site.com', subject: 'New: {{email}}', body: '<p>got one</p>', include_all: true } },
      { type: 'email', config: { to: '{{email}}', subject: 'Thanks', body: '<p>Hi {{email}}</p>' } },
    ],
    success_message: 'Tack!',
    created_at: new Date().toISOString(),
  });
}

async function seedConnector() {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.integrations(ORG, SITE), {
    email: { type: 'smtp', from: 'Site <no-reply@site.com>', config: { host: 'h', port: 587, secure: false, user: 'u', password_enc: '' } },
  } satisfies SiteIntegrations);
}

function signedToken(formId = 'kontakt'): Promise<string> {
  return import('../../lib/forms-signing').then(({ signFormToken }) => signFormToken(ORG, SITE, formId));
}
async function callSubmit(request: Request): Promise<Response> {
  const mod = await import('../../pages/api/forms/submit');
  return mod.POST({ request } as any) as Promise<Response>;
}
function submitReq(token: string, data: Record<string, string>): Request {
  return new Request('http://localhost/api/forms/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, data }),
  });
}

describe('form email actions', () => {
  beforeEach(async () => {
    await resetDatastore();
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ok: true, id: 'x' });
  });

  it('sends each email action through the connector after storing the submission', async () => {
    await setup();
    await seedFormWithEmailAction();
    await seedConnector();
    const res = await callSubmit(submitReq(await signedToken(), { email: 'user@x.com', message: 'Hej' }));
    expect(res.status).toBe(200);

    expect(sendMock).toHaveBeenCalledTimes(2);
    const recipients = sendMock.mock.calls.map((c) => (c[1] as { to: string }).to);
    expect(recipients).toContain('admin@site.com');
    expect(recipients).toContain('user@x.com');
    // include_all dumped the submitted message into the admin email.
    const adminMsg = sendMock.mock.calls.find((c) => (c[1] as { to: string }).to === 'admin@site.com')![1] as { html: string };
    expect(adminMsg.html).toContain('Hej');

    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs(paths.submissions(ORG, SITE))).toHaveLength(1);
  });

  it('skips email actions when no connector is configured (submission still stored)', async () => {
    await setup();
    await seedFormWithEmailAction();
    const res = await callSubmit(submitReq(await signedToken(), { email: 'user@x.com', message: 'Hej' }));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().listDocs(paths.submissions(ORG, SITE))).toHaveLength(1);
  });

  it('still returns 200 when a send fails', async () => {
    await setup();
    await seedFormWithEmailAction();
    await seedConnector();
    sendMock.mockResolvedValue({ ok: false, error: 'boom' });
    const res = await callSubmit(submitReq(await signedToken(), { email: 'user@x.com', message: 'Hej' }));
    expect(res.status).toBe(200);
  });

  it('skips an action whose recipient cannot be resolved, sends the rest', async () => {
    await setup();
    await seedConnector();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/kontakt`, {
      name: 'K',
      steps: [{ id: 'main', blocks: [
        { id: 'f-email', type: 'form/email', data: { name: 'email', label: 'E', required: true } },
      ] }],
      actions: [
        { type: 'email', config: { to: '{{nonexistent}}', subject: 's', body: 'b' } },
        { type: 'email', config: { to: 'admin@site.com', subject: 's', body: 'b' } },
      ],
      created_at: new Date().toISOString(),
    });
    const res = await callSubmit(submitReq(await signedToken(), { email: 'user@x.com' }));
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0]![1] as { to: string }).to).toBe('admin@site.com');
  });
});
