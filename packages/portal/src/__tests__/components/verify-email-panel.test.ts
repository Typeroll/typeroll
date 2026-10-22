// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import VerifyEmailPanel from '../../components/VerifyEmailPanel';
let root: Root;
let container: HTMLDivElement;
async function render(props: Record<string, unknown> = {}) {
  await act(async () => root.render(createElement(VerifyEmailPanel, { email: 'person@example.test', next: '/onboarding?invite=abc', ...props })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const click = async (text: string) => act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text))!.click(); });
const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

it('explains what is blocked and offers resend, re-check and sign out', async () => {
  await render({ sent: true });
  expect(container.textContent).toContain('We sent a confirmation link to person@example.test');
  expect(container.textContent).toContain('cannot create or join an organization');
  expect(container.querySelector('form[action="/api/auth/logout"][method="POST"] button')?.textContent).toBe('Sign out');
  expect([...container.querySelectorAll('button')].map(b => b.textContent)).toEqual(["I've confirmed my email", 'Resend confirmation email', 'Sign out']);
});

it('sends a link with the continuation and reports rate limiting', async () => {
  await render();
  expect(container.textContent).toContain('Confirm your email address to continue');
  const request = reply(202, { ok: true, verified: false });
  vi.stubGlobal('fetch', request);
  await click('Send confirmation email');
  expect(request).toHaveBeenCalledWith('/api/auth/verification-email', expect.objectContaining({ method: 'POST', body: JSON.stringify({ next: '/onboarding?invite=abc' }) }));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('We sent a new confirmation link to person@example.test');
  vi.stubGlobal('fetch', reply(429, { error: 'Too many attempts.' }));
  await click('Resend confirmation email');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Too many attempts');
});

it('continues only after the server confirms the address', async () => {
  await render();
  vi.stubGlobal('fetch', reply(200, { ok: true, verified: false }));
  await click("I've confirmed");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('not confirmed yet');
  vi.stubGlobal('fetch', reply(200, { ok: true, verified: true }));
  await click("I've confirmed");
  expect(window.location.pathname + window.location.search).toBe('/onboarding?invite=abc');
});
