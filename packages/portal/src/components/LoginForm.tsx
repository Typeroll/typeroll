import { useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  setPersistence,
  inMemoryPersistence,
  signOut,
} from 'firebase/auth';
import { getFirebaseAuth } from '../lib/firebase-client';

import { authErrorMessage } from '../lib/auth-errors';

type Mode = 'signin' | 'signup' | 'reset';

export default function LoginForm({ next = null }: { next?: string | null }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  async function exchangeIdToken(idToken: string) {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw Object.assign(new Error('Session exchange failed'), { code: res.status === 429 ? 'auth/too-many-requests' : 'auth/session-failed' });
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
        if (mode === 'signup') await updateProfile(result.user, { displayName: name.trim() });
        const idToken = await result.user.getIdToken(true);
        await exchangeIdToken(idToken);
      } finally {
        await signOut(auth);
      }
    });
  }

  return (
    <div className="stack">
      <h2 style={{ fontSize: '1.125rem' }}>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create your account' : 'Reset your password'}</h2>
      <form onSubmit={handleEmail} className="stack" data-login-ready={hydrated ? 'true' : 'false'}>
        {mode === 'signup' && <>
          <p className="muted text-sm">First, create your personal account. Next, name your organization or join one with an invitation.</p>
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
          {mode === 'signin' ? 'Sign in' : mode === 'reset' ? 'Send reset link' : 'Create account'}
        </button>
      </form>

      <button type="button" disabled={busy || !hydrated} onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setNotice(null); }} className="btn btn--ghost" style={{ width: '100%', justifyContent: 'center' }}>
        {mode === 'signin' ? "Need an account? Sign up" : 'Already have an account? Sign in'}
      </button>
      {mode === 'signin' && <button type="button" className="btn btn--ghost" disabled={busy || !hydrated} onClick={() => { setMode('reset'); setError(null); setNotice(null); }}>Forgot password?</button>}
    </div>
  );
}
