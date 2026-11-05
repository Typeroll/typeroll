// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LoginForm from '../../components/LoginForm';
import { oauthErrorMessage } from '../../lib/auth-errors';

let root: Root;
let container: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
const location = { href: '' };

async function mount(props: Record<string, unknown> = {}) {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = '';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(LoginForm, props)));
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sent = (index = 0) => ({ url: request.mock.calls[index]![0] as string, body: JSON.parse((request.mock.calls[index]![1] as RequestInit).body as string) });

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request = vi.fn(async () => reply(200, { user: { emailVerified: true } }));
  vi.stubGlobal('fetch', request);
  location.href = '';
  vi.spyOn(window, 'location', 'get').mockReturnValue(location as unknown as Location);
  await mount();
});
afterEach(async () => { await act(async () => root.unmount()); root = undefined as unknown as Root; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const click = async (text: string) => act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text))!.click(); });
async function input(id: string, value: string) { await act(async () => {
  const field = container.querySelector<HTMLInputElement>(`#${id}`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}); }
const submit = async () => act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

it('collects a personal name separately from organization onboarding', async () => {
  expect(container.textContent).not.toContain('Continue with Google');
  await click('Sign up');
  expect(container.querySelector('#login-name')).not.toBeNull();
  expect(container.textContent).toContain('name your organization or join one');
  expect(container.querySelector<HTMLInputElement>('#login-password')!.minLength).toBe(12);
});

it('requests a password reset without a password and without revealing the account', async () => {
  await click('Forgot password'); await input('login-email', ' test@example.test '); await submit();
  expect(container.querySelector('#login-password')).toBeNull();
  expect(sent()).toEqual({ url: '/api/auth/request-password-reset', body: { email: 'test@example.test', redirectTo: '/reset-password' } });
  expect(container.querySelector('[role="status"]')?.textContent).toContain('If this address has an account');
});

it('signs in and continues to the requested page', async () => {
  await mount({ next: '/app/sites' });
  await input('login-email', 'test@example.test'); await input('login-password', 'correct horse battery'); await submit();
  expect(sent()).toEqual({ url: '/api/auth/sign-in/email', body: { email: 'test@example.test', password: 'correct horse battery', rememberMe: true } });
  expect(location.href).toBe('/app/sites');
});

it('sends an unconfirmed account to "Check your email"', async () => {
  request.mockResolvedValueOnce(reply(200, { user: { emailVerified: false } }));
  await mount({ next: '/app/sites' });
  await input('login-email', 'test@example.test'); await input('login-password', 'correct horse battery'); await submit();
  expect(location.href).toBe('/verify-email?next=%2Fapp%2Fsites');
});

it('creates an account and continues to "Check your email" with the link sent', async () => {
  await click('Sign up'); await input('login-name', ' Test Person '); await input('login-email', 'test@example.test'); await input('login-password', 'long-password-123'); await submit();
  expect(sent()).toEqual({ url: '/api/auth/sign-up/email', body: { name: 'Test Person', email: 'test@example.test', password: 'long-password-123', callbackURL: '/verify-email' } });
  expect(location.href).toBe('/verify-email?sent=1');
});

it('maps account errors to safe copy', async () => {
  request.mockResolvedValueOnce(reply(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'INTERNAL details' }));
  await input('login-email', 'test@example.test'); await input('login-password', 'password'); await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not sign in');
  expect(container.textContent).not.toContain('INTERNAL');
  request.mockResolvedValueOnce(reply(429, {}));
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Too many attempts');
  expect(location.href).toBe('');
});

it('shows GitHub sign-in only when the deployment enables it and starts it on the server', async () => {
  expect(container.textContent).not.toContain('Continue with GitHub');
  await mount({ githubSignIn: true, next: '/app/sites' });
  request.mockResolvedValueOnce(reply(200, { url: 'https://github.com/login/oauth/authorize?state=x', redirect: true }));
  await click('Continue with GitHub');
  expect(sent()).toEqual({ url: '/api/auth/sign-in/social', body: { provider: 'github', callbackURL: '/app/sites', errorCallbackURL: '/login?next=%2Fapp%2Fsites' } });
  expect(location.href).toBe('https://github.com/login/oauth/authorize?state=x');
});

it('explains a GitHub sign-in that could not be linked', async () => {
  await mount({ initialError: oauthErrorMessage('unable_to_link_account') });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('An account already uses this email address');
  expect(oauthErrorMessage(null)).toBeNull();
});
