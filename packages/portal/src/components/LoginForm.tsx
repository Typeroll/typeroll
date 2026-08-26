import { useState } from 'react';
import {
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { getFirebaseAuth } from '../lib/firebase-client';

type Mode = 'signin' | 'signup';

export default function LoginForm() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function exchangeIdToken(idToken: string) {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw new Error('Session exchange failed');
    window.location.href = '/app';
  }

  async function withFirebase<T>(fn: () => Promise<T>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    await withFirebase(async () => {
      const auth = getFirebaseAuth();
      if (!auth) throw new Error('Firebase not configured');
      const result = mode === 'signin'
        ? await signInWithEmailAndPassword(auth, email, password)
        : await createUserWithEmailAndPassword(auth, email, password);
      const idToken = await result.user.getIdToken();
      await exchangeIdToken(idToken);
    });
  }

  async function handleGoogle() {
    await withFirebase(async () => {
      const auth = getFirebaseAuth();
      if (!auth) throw new Error('Firebase not configured');
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = await result.user.getIdToken();
      await exchangeIdToken(idToken);
    });
  }

  return (
    <div className="stack">
      <button type="button" onClick={handleGoogle} disabled={busy} className="btn btn--secondary" style={{ width: '100%', justifyContent: 'center' }}>
        Continue with Google
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
        <span className="muted text-sm">or</span>
        <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
      </div>

      <form onSubmit={handleEmail} className="stack">
        <div className="field">
          <label>Email</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
        </div>
        {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}
        <button type="submit" disabled={busy} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <button type="button" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')} className="btn btn--ghost" style={{ width: '100%', justifyContent: 'center' }}>
        {mode === 'signin' ? "Need an account? Sign up" : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}
