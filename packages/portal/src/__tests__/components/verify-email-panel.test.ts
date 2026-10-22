// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import VerifyEmailPanel, { CONFIRMATION_POLL_MS, CONFIRMATION_POLL_WINDOW_MS } from '../../components/VerifyEmailPanel';
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

const unconfirmed = () => reply(200, { ok: true, verified: false });

it('explains what is blocked and offers only resend and sign out', async () => {
  vi.stubGlobal('fetch', unconfirmed());
  await render({ sent: true });
  expect(container.textContent).toContain('We sent a confirmation link to person@example.test');
  expect(container.textContent).toContain('continues by itself once the address is confirmed');
  expect(container.textContent).toContain('cannot create or join an organization');
  expect(container.querySelector('form[action="/api/auth/logout"][method="POST"] button')?.textContent).toBe('Sign out');
  expect([...container.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Resend confirmation email', 'Sign out']);
});

it('sends a link with the continuation and reports rate limiting', async () => {
  vi.stubGlobal('fetch', unconfirmed());
  await render();
  expect(container.textContent).toContain('Confirm your email address to continue');
  const request = reply(202, { ok: true, verified: false });
  vi.stubGlobal('fetch', request);
  await click('Send confirmation email');
  expect(request).toHaveBeenCalledWith('/api/auth/verification-email', expect.objectContaining({ method: 'POST', body: JSON.stringify({ next: '/onboarding?invite=abc' }) }));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('We sent a confirmation link to person@example.test');
  vi.stubGlobal('fetch', reply(429, { error: 'Too many attempts.' }));
  await click('Resend confirmation email');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Too many attempts');
});

it('asks the server on open and continues as soon as it confirms', async () => {
  const request = reply(200, { ok: true, verified: true });
  vi.stubGlobal('fetch', request);
  await render();
  await act(async () => { await Promise.resolve(); });
  expect(request).toHaveBeenCalledWith('/api/auth/verification-status', expect.objectContaining({ method: 'POST' }));
  expect(window.location.pathname + window.location.search).toBe('/onboarding?invite=abc');
});

it('keeps checking quietly while visible and when the tab is shown again', async () => {
  vi.useFakeTimers();
  try {
    const request = unconfirmed();
    vi.stubGlobal('fetch', request);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const statusCalls = () => request.mock.calls.filter(([url]) => url === '/api/auth/verification-status').length;
    expect(statusCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIRMATION_POLL_MS); });
    expect(statusCalls()).toBe(2);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(statusCalls()).toBe(3);
    // Not confirmed yet is not an error.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // After the polling window only tab changes trigger a check.
    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIRMATION_POLL_WINDOW_MS + CONFIRMATION_POLL_MS * 2); });
    const afterWindow = statusCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIRMATION_POLL_MS * 3); });
    expect(statusCalls()).toBe(afterWindow);
  } finally { vi.useRealTimers(); }
});

it('stops checking and says so when the sign-in has expired', async () => {
  vi.stubGlobal('fetch', reply(401, { error: 'Sign in again to continue.' }));
  await render();
  await act(async () => { await Promise.resolve(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your sign-in has expired');
});
