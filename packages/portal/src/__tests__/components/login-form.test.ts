// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LoginForm from '../../components/LoginForm';
const auth = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(), createUserWithEmailAndPassword: vi.fn(), updateProfile: vi.fn(),
  sendPasswordResetEmail: vi.fn(), setPersistence: vi.fn(), signOut: vi.fn(), inMemoryPersistence: {},
}));
vi.mock('firebase/auth', () => auth);
vi.mock('../../lib/firebase-client', () => ({ getFirebaseAuth: () => ({}) }));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(LoginForm)));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
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
