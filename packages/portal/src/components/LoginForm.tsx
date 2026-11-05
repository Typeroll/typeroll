import { useEffect, useState } from 'react';
import { authErrorMessage } from '../lib/auth-errors';

type Mode = 'signin' | 'signup' | 'reset';

interface Props {
  next?: string | null;
  /** `login?mode=signup` opens account creation directly. */
  initialMode?: 'signin' | 'signup';
  /** Shown only when the deployment configured a GitHub OAuth App. */
  githubSignIn?: boolean;
  /** Message for a failed GitHub sign-in (`/login?error=…`). */
  initialError?: string | null;
}

interface AuthResult { user?: { emailVerified?: boolean }; url?: string; redirect?: boolean }

/** POST to a Better Auth endpoint; throws `{ code, status }` on failure. */
async function authPost(path: string, body: Record<string, unknown>): Promise<AuthResult> {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    throw { code: 'NETWORK' };
  }
  const data = await response.json().catch(() => ({})) as AuthResult & { code?: string };
  if (!response.ok) throw { code: data.code, status: response.status };
  return data;
}

function verifyEmailPath(next: string | null, sent: boolean): string {
  const params = new URLSearchParams();
  if (next) params.set('next', next);
  if (sent) params.set('sent', '1');
  const query = params.toString();
  return `/verify-email${query ? `?${query}` : ''}`;
}

export default function LoginForm({ next = null, initialMode = 'signin', githubSignIn = false, initialError = null }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => { setHydrated(true); }, []);

  async function run(fn: () => Promise<void>) {
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

  async function handleGithub() {
    await run(async () => {
      // Sign-in reads the person's email addresses only. Publishing uses the
      // Organization's GitHub App installation, never this sign-in.
      const result = await authPost('/sign-in/social', {
        provider: 'github',
        callbackURL: next ?? '/app',
        errorCallbackURL: `/login${next ? `?next=${encodeURIComponent(next)}` : ''}`,
      });
      if (!result.url) throw { code: 'GITHUB' };
      window.location.href = result.url;
    });
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const address = email.trim();
      if (mode === 'reset') {
        await authPost('/request-password-reset', { email: address, redirectTo: '/reset-password' });
        setNotice('If this address has an account, you will receive a password reset email.');
        return;
      }
      if (mode === 'signup') {
        if (!name.trim()) { setError('Enter your name.'); return; }
        // The server sends the confirmation link; the account is signed in
        // but only reaches "Check your email" until the address is confirmed.
        await authPost('/sign-up/email', { name: name.trim(), email: address, password, callbackURL: verifyEmailPath(next, false) });
        window.location.href = verifyEmailPath(next, true);
        return;
      }
      const result = await authPost('/sign-in/email', { email: address, password, rememberMe: true });
      window.location.href = result.user?.emailVerified === false ? verifyEmailPath(next, false) : next ?? '/app';
    });
  }

  return (
    <div className="stack">
      <h2 style={{ fontSize: '1.125rem' }}>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create your account' : 'Reset your password'}</h2>
      {githubSignIn && mode !== 'reset' && <>
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
          <input id="login-password" type="password" disabled={busy || !hydrated} required minLength={mode === 'signup' ? 12 : undefined} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
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
