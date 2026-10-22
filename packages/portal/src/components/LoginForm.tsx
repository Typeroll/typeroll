import { useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  sendEmailVerification,
  setPersistence,
  inMemoryPersistence,
  signOut,
  GithubAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  getAdditionalUserInfo,
  linkWithCredential,
  type Auth,
  type AuthCredential,
  type User,
  type UserCredential,
} from 'firebase/auth';
import { getFirebaseAuth } from '../lib/firebase-client';

import { authErrorMessage } from '../lib/auth-errors';

type Mode = 'signin' | 'signup' | 'reset';

interface Props {
  next?: string | null;
  /** Shown only when the deployment enabled Firebase's GitHub provider
   *  (PUBLIC_FIREBASE_GITHUB_SIGNIN=true). */
  githubSignIn?: boolean;
}

/** A GitHub sign-in whose email already belongs to a password account. The
 *  credential stays in memory until the person proves the existing account. */
interface PendingGithubLink { credential: AuthCredential; email: string | null }

/** Firebase's confirmation page links back to "Check your email" on this portal. */
function verificationContinueUrl(next: string | null): string {
  const url = new URL('/verify-email', window.location.origin);
  if (next) url.searchParams.set('next', next);
  return url.toString();
}

/** Best effort: the "Check your email" page can always send another link. */
async function sendConfirmation(user: User, next: string | null): Promise<boolean> {
  try {
    await sendEmailVerification(user, { url: verificationContinueUrl(next) });
    return true;
  } catch {
    // A portal domain missing from Firebase's authorized domains rejects the
    // continue URL; Firebase's default confirmation page still works.
    try { await sendEmailVerification(user); return true; } catch { return false; }
  }
}

/** Sign-in needs the person's (possibly private) email address and nothing
 *  else: public profile data is included without a scope. Never request repo
 *  access here; publishing uses the Organization's GitHub App installation. */
function githubProvider(): GithubAuthProvider {
  const provider = new GithubAuthProvider();
  provider.addScope('user:email');
  return provider;
}

const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;

export default function LoginForm({ next = null, githubSignIn = false }: Props) {
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [pendingLink, setPendingLink] = useState<PendingGithubLink | null>(null);

  useEffect(() => {
    setHydrated(true);
    // Finish a GitHub sign-in that fell back to a full-page redirect.
    if (!githubSignIn) return;
    const auth = getFirebaseAuth();
    if (!auth) return;
    void withFirebase(async () => {
      await setPersistence(auth, inMemoryPersistence);
      let result: UserCredential | null;
      try { result = await getRedirectResult(auth); }
      catch (e) { if (offerGithubLink(e)) return; throw e; }
      if (result) await finishGithub(auth, result);
    });
  }, []);

  async function exchangeIdToken(idToken: string, verificationSent = false) {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw Object.assign(new Error('Session exchange failed'), { code: res.status === 429 ? 'auth/too-many-requests' : 'auth/session-failed' });
    const data = await res.json().catch(() => ({})) as { verificationRequired?: boolean };
    // The server decides from the verified ID token: an account without a
    // confirmed email only gets the "Check your email" page.
    if (data.verificationRequired) {
      const params = new URLSearchParams();
      if (next) params.set('next', next);
      if (verificationSent) params.set('sent', '1');
      const query = params.toString();
      window.location.href = `/verify-email${query ? `?${query}` : ''}`;
      return;
    }
    window.location.href = next ?? '/app';
  }

  async function withFirebase<T>(fn: () => Promise<T>) {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** Firebase's recommended flow for an address that already has a password
   *  account: sign in with the password, then link the GitHub credential. */
  function offerGithubLink(e: unknown): boolean {
    if (errorCode(e) !== 'auth/account-exists-with-different-credential') return false;
    const credential = GithubAuthProvider.credentialFromError(e as Parameters<typeof GithubAuthProvider.credentialFromError>[0]);
    const existingEmail = (e as { customData?: { email?: unknown } }).customData?.email;
    setMode('signin');
    setPassword('');
    if (typeof existingEmail === 'string') setEmail(existingEmail);
    if (!credential) {
      setNotice('An account already uses this email address. Sign in with your email and password.');
      return true;
    }
    setPendingLink({ credential, email: typeof existingEmail === 'string' ? existingEmail : null });
    setNotice('An account already uses this email address. Sign in with your password to link GitHub to it. If you used Google before, choose Forgot password? first.');
    return true;
  }

  async function finishGithub(auth: Auth, result: UserCredential) {
    try {
      // GitHub addresses are not confirmed for Firebase (email_verified is
      // false), so a new account receives a confirmation link right away.
      const isNewUser = getAdditionalUserInfo(result)?.isNewUser === true;
      const sent = isNewUser && !result.user.emailVerified ? await sendConfirmation(result.user, next) : false;
      await exchangeIdToken(await result.user.getIdToken(true), sent);
    } finally {
      await signOut(auth);
    }
  }

  async function handleGithub() {
    await withFirebase(async () => {
      const auth = getFirebaseAuth();
      if (!auth) throw new Error('Firebase not configured');
      await setPersistence(auth, inMemoryPersistence);
      let result: UserCredential;
      try {
        result = await signInWithPopup(auth, githubProvider());
      } catch (e) {
        const code = errorCode(e);
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-environment') {
          // The page navigates to GitHub; the effect above finishes on return.
          await signInWithRedirect(auth, githubProvider());
          return;
        }
        if (offerGithubLink(e)) return;
        throw e;
      }
      await finishGithub(auth, result);
    });
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    await withFirebase(async () => {
      const auth = getFirebaseAuth();
      if (!auth) throw new Error('Firebase not configured');
      await setPersistence(auth, inMemoryPersistence);
      if (mode === 'reset') {
        await sendPasswordResetEmail(auth, email.trim());
        setNotice('If this address has an account, you will receive a password reset email.');
        return;
      }
      if (mode === 'signup' && !name.trim()) {
        setError('Enter your name.');
        return;
      }
      const result = mode === 'signin'
        ? await signInWithEmailAndPassword(auth, email.trim(), password)
        : await createUserWithEmailAndPassword(auth, email.trim(), password);
      try {
        let sent = false;
        if (mode === 'signup') {
          await updateProfile(result.user, { displayName: name.trim() });
          if (!result.user.emailVerified) sent = await sendConfirmation(result.user, next);
        }
        if (mode === 'signin' && pendingLink) {
          const link = pendingLink;
          setPendingLink(null);
          await linkWithCredential(result.user, link.credential);
        }
        const idToken = await result.user.getIdToken(true);
        await exchangeIdToken(idToken, sent);
      } finally {
        await signOut(auth);
      }
    });
  }

  const linking = mode === 'signin' && pendingLink !== null;

  return (
    <div className="stack">
      <h2 style={{ fontSize: '1.125rem' }}>{linking ? 'Link GitHub to your account' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create your account' : 'Reset your password'}</h2>
      {githubSignIn && mode !== 'reset' && !linking && <>
        <button type="button" onClick={handleGithub} disabled={busy || !hydrated} className="btn btn--secondary" style={{ width: '100%', justifyContent: 'center' }}>
          Continue with GitHub
        </button>
        <p className="muted text-sm">Signing in with GitHub does not connect GitHub for publishing.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} aria-hidden="true">
          <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
          <span className="muted text-sm">or</span>
          <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
        </div>
      </>}
      <form onSubmit={handleEmail} className="stack" data-login-ready={hydrated ? 'true' : 'false'}>
        {mode === 'signup' && <>
          <p className="muted text-sm">First, create your personal account and confirm your email address. Next, name your organization or join one with an invitation.</p>
          <div className="field"><label htmlFor="login-name">Your name</label><input id="login-name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} disabled={busy || !hydrated} /></div>
        </>}
        {mode === 'reset' && <p className="muted text-sm">Request a password reset link. This also works if you previously signed in with Google using this address.</p>}
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" disabled={busy || !hydrated} required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        {mode !== 'reset' && <div className="field">
          <label htmlFor="login-password">Password</label>
          <input id="login-password" type="password" disabled={busy || !hydrated} required minLength={mode === 'signup' ? 12 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
          {mode === 'signup' && <span className="muted text-sm">Use at least 12 characters.</span>}
        </div>}
        {notice && <p role="status">{notice}</p>}
        {error && <div role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}
        <button type="submit" disabled={busy || !hydrated} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
          {linking ? 'Sign in and link GitHub' : mode === 'signin' ? 'Sign in' : mode === 'reset' ? 'Send reset link' : 'Create account'}
        </button>
      </form>

      {linking && <button type="button" disabled={busy || !hydrated} onClick={() => { setPendingLink(null); setNotice(null); setError(null); }} className="btn btn--ghost" style={{ width: '100%', justifyContent: 'center' }}>
        Sign in without linking GitHub
      </button>}
      <button type="button" disabled={busy || !hydrated} onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setPendingLink(null); setError(null); setNotice(null); }} className="btn btn--ghost" style={{ width: '100%', justifyContent: 'center' }}>
        {mode === 'signin' ? "Need an account? Sign up" : 'Already have an account? Sign in'}
      </button>
      {mode === 'signin' && <button type="button" className="btn btn--ghost" disabled={busy || !hydrated} onClick={() => { setMode('reset'); setError(null); setNotice(null); }}>Forgot password?</button>}
    </div>
  );
}
