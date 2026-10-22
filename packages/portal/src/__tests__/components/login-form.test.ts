// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LoginForm from '../../components/LoginForm';
const auth = vi.hoisted(() => {
  const providers: Array<{ scopes: string[] }> = [];
  class GithubAuthProvider {
    scopes: string[] = [];
    static credentialFromError = vi.fn();
    constructor() { providers.push(this); }
    addScope(scope: string) { this.scopes.push(scope); return this; }
  }
  return {
    providers, GithubAuthProvider,
    signInWithEmailAndPassword: vi.fn(), createUserWithEmailAndPassword: vi.fn(), updateProfile: vi.fn(),
    sendPasswordResetEmail: vi.fn(), sendEmailVerification: vi.fn(), setPersistence: vi.fn(), signOut: vi.fn(), inMemoryPersistence: {},
    signInWithPopup: vi.fn(), signInWithRedirect: vi.fn(), getRedirectResult: vi.fn(async (): Promise<unknown> => null),
    getAdditionalUserInfo: vi.fn(), linkWithCredential: vi.fn(),
  };
});
vi.mock('firebase/auth', () => auth);
vi.mock('../../lib/firebase-client', () => ({ getFirebaseAuth: () => ({}) }));
let root: Root;
let container: HTMLDivElement;
async function mount(props: Record<string, unknown> = {}) {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = '';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(LoginForm, props)));
}
beforeEach(async () => {
  vi.clearAllMocks(); auth.providers.length = 0; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await mount();
});
afterEach(async () => { await act(async () => root.unmount()); root = undefined as unknown as Root; document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const click = async (text: string) => act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text))!.click(); });
async function input(id: string, value: string) { await act(async () => {
  const field = container.querySelector<HTMLInputElement>(`#${id}`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}); }
const submit = async () => act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
it('removes Google sign-in and collects a personal name separately from organization onboarding', async () => {
  expect(container.textContent).not.toContain('Continue with Google');
  await click('Sign up');
  expect(container.querySelector('#login-name')).not.toBeNull();
  expect(container.textContent).toContain('name your organization or join one');
  expect(container.querySelector<HTMLInputElement>('#login-password')!.minLength).toBe(12);
  expect(container.querySelector('[autocomplete="organization"]')).toBeNull();
});
it('resets a password without requiring a password or sending portal credentials', async () => {
  await click('Forgot password'); await input('login-email', 'test@example.test'); await submit();
  expect(container.querySelector('#login-password')).toBeNull();
  expect(auth.sendPasswordResetEmail).toHaveBeenCalledWith({}, 'test@example.test');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('If this address has an account');
  expect(auth.signInWithEmailAndPassword).not.toHaveBeenCalled();
});
it('maps account errors to safe copy', async () => {
  auth.signInWithEmailAndPassword.mockRejectedValueOnce({ code: 'auth/user-not-found', message: 'INTERNAL details' });
  await input('login-email', 'test@example.test'); await input('login-password', 'password'); await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not sign in');
  expect(container.textContent).not.toContain('INTERNAL');
});
it('sets name before session exchange and removes Firebase client state on failure', async () => {
  const user = { getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  auth.createUserWithEmailAndPassword.mockResolvedValueOnce({ user });
  const request = vi.fn().mockResolvedValue(new Response('', { status: 429 })); vi.stubGlobal('fetch', request);
  await click('Sign up'); await input('login-name', 'Test Person'); await input('login-email', 'test@example.test'); await input('login-password', 'long-password-123'); await submit();
  expect(auth.updateProfile).toHaveBeenCalledWith(user, { displayName: 'Test Person' });
  expect(user.getIdToken).toHaveBeenCalledWith(true);
  expect(auth.updateProfile.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
  expect(auth.signOut).toHaveBeenCalled();
  expect(container.textContent).toContain('Too many attempts');
});
it('opens account creation directly when asked to (login?mode=signup)', async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(createElement(LoginForm, { initialMode: 'signup' })));
  expect(container.querySelector('h2')?.textContent).toBe('Create your account');
  expect(container.querySelector('#login-name')).not.toBeNull();
  await click('Already have an account? Sign in');
  expect(container.querySelector('h2')?.textContent).toBe('Sign in');
});
it('sends an email confirmation after sign-up and continues to "Check your email"', async () => {
  const user = { emailVerified: false, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  auth.createUserWithEmailAndPassword.mockResolvedValueOnce({ user });
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, verificationRequired: true }), { status: 200 }));
  vi.stubGlobal('fetch', request);
  await click('Sign up'); await input('login-name', 'Test Person'); await input('login-email', 'test@example.test'); await input('login-password', 'long-password-123'); await submit();
  expect(auth.sendEmailVerification).toHaveBeenCalledWith(user, { url: `${window.location.origin}/verify-email` });
  expect(auth.sendEmailVerification.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
  expect(auth.signOut).toHaveBeenCalled();
  expect(window.location.pathname).toBe('/verify-email');
  expect(window.location.search).toBe('?sent=1');
});
it('still creates the account when Firebase rejects the continue URL', async () => {
  const user = { emailVerified: false, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  auth.createUserWithEmailAndPassword.mockResolvedValueOnce({ user });
  auth.sendEmailVerification.mockRejectedValueOnce({ code: 'auth/unauthorized-continue-uri' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, verificationRequired: true }))));
  await click('Sign up'); await input('login-name', 'Test Person'); await input('login-email', 'test@example.test'); await input('login-password', 'long-password-123'); await submit();
  expect(auth.sendEmailVerification).toHaveBeenLastCalledWith(user);
  expect(window.location.pathname).toBe('/verify-email');
});
it('shows GitHub sign-in only when the deployment enables it', async () => {
  expect(container.textContent).not.toContain('Continue with GitHub');
  await mount({ githubSignIn: true });
  expect(container.textContent).toContain('Continue with GitHub');
  expect(container.textContent).toContain('does not connect GitHub for publishing');
  // A returning redirect is checked on load, and nothing is pending here.
  expect(auth.getRedirectResult).toHaveBeenCalledTimes(1);
  expect(auth.signOut).not.toHaveBeenCalled();
});
it('signs in with GitHub using only the email scope and confirms a new account', async () => {
  await mount({ githubSignIn: true, next: '/onboarding?invite=abc' });
  const user = { emailVerified: false, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  const result = { user, providerId: 'github.com', _tokenResponse: { oauthAccessToken: 'gho_synthetic' } };
  auth.signInWithPopup.mockResolvedValueOnce(result);
  auth.getAdditionalUserInfo.mockReturnValueOnce({ isNewUser: true, providerId: 'github.com' });
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, verificationRequired: true })));
  vi.stubGlobal('fetch', request);
  await click('Continue with GitHub');
  expect(auth.providers.at(-1)?.scopes).toEqual(['user:email']);
  expect(auth.sendEmailVerification).toHaveBeenCalledWith(user, { url: `${window.location.origin}/verify-email?next=%2Fonboarding%3Finvite%3Dabc` });
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ idToken: 'synthetic-token' });
  expect(JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)])).not.toContain('gho_');
  expect(auth.signOut).toHaveBeenCalled();
  expect(window.location.pathname + window.location.search).toBe('/verify-email?next=%2Fonboarding%3Finvite%3Dabc&sent=1');
});
it('falls back to a redirect when the browser blocks the GitHub popup', async () => {
  await mount({ githubSignIn: true });
  auth.signInWithPopup.mockRejectedValueOnce({ code: 'auth/popup-blocked' });
  await click('Continue with GitHub');
  expect(auth.signInWithRedirect).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('explains an existing password account and links GitHub after password sign-in', async () => {
  await mount({ githubSignIn: true });
  const credential = { providerId: 'github.com' };
  auth.signInWithPopup.mockRejectedValueOnce({ code: 'auth/account-exists-with-different-credential', customData: { email: 'person@example.test' } });
  auth.GithubAuthProvider.credentialFromError.mockReturnValueOnce(credential);
  await click('Continue with GitHub');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('An account already uses this email address. Sign in with your password to link GitHub');
  expect(container.querySelector('h2')?.textContent).toBe('Link GitHub to your account');
  expect(container.querySelector<HTMLInputElement>('#login-email')!.value).toBe('person@example.test');
  expect(container.textContent).not.toContain('Continue with GitHub');

  const user = { emailVerified: true, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  auth.signInWithEmailAndPassword.mockResolvedValueOnce({ user });
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, verificationRequired: false })));
  vi.stubGlobal('fetch', request);
  await input('login-password', 'password'); await submit();
  expect(auth.linkWithCredential).toHaveBeenCalledWith(user, credential);
  expect(auth.linkWithCredential.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
  expect(window.location.pathname).toBe('/app');
});
it('reports a failed link without signing in and can continue without linking', async () => {
  await mount({ githubSignIn: true });
  auth.signInWithPopup.mockRejectedValueOnce({ code: 'auth/account-exists-with-different-credential', customData: { email: 'person@example.test' } });
  auth.GithubAuthProvider.credentialFromError.mockReturnValueOnce({ providerId: 'github.com' });
  await click('Continue with GitHub');
  auth.signInWithEmailAndPassword.mockResolvedValueOnce({ user: { getIdToken: vi.fn() } });
  auth.linkWithCredential.mockRejectedValueOnce({ code: 'auth/credential-already-in-use' });
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  await input('login-password', 'password'); await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('already linked to another Typeroll account');
  expect(request).not.toHaveBeenCalled();
  expect(auth.signOut).toHaveBeenCalled();
  expect(container.querySelector('h2')?.textContent).toBe('Sign in');
});
it('finishes a GitHub redirect sign-in when the page loads again', async () => {
  const user = { emailVerified: true, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  auth.getRedirectResult.mockResolvedValueOnce({ user });
  auth.getAdditionalUserInfo.mockReturnValueOnce({ isNewUser: false });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, verificationRequired: false }))));
  await mount({ githubSignIn: true, next: '/app/settings' });
  await act(async () => { await Promise.resolve(); });
  expect(auth.sendEmailVerification).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe('/app/settings');
});
it('does not send a confirmation on sign-in and follows the server decision', async () => {
  const user = { emailVerified: true, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  auth.signInWithEmailAndPassword.mockResolvedValueOnce({ user });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, verificationRequired: false }))));
  await input('login-email', 'test@example.test'); await input('login-password', 'password'); await submit();
  expect(auth.sendEmailVerification).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe('/app');
});
