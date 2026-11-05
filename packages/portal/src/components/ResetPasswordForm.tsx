import { useEffect, useState } from 'react';
import { authErrorMessage } from '../lib/auth-errors';

interface Props {
  /** The reset token from the emailed link, or null when the link was invalid. */
  token: string | null;
}

/** Choose a new password. A successful reset signs the person out everywhere. */
export default function ResetPasswordForm({ token }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This link has expired or was already used. Request a new one.');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !token) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ token, newPassword: password }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { code?: string };
        throw { code: data.code, status: response.status };
      }
      setDone(true);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally { setBusy(false); }
  }

  if (done) return (
    <div className="stack">
      <p role="status">Your password was changed and you were signed out everywhere.</p>
      <a className="btn" href="/login" style={{ justifyContent: 'center' }}>Sign in</a>
    </div>
  );

  return (
    <form onSubmit={submit} className="stack" data-reset-ready={hydrated ? 'true' : 'false'}>
      <div className="field">
        <label htmlFor="reset-password">New password</label>
        <input id="reset-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} disabled={busy || !hydrated || !token} />
        <span className="muted text-sm">Use at least 12 characters.</span>
      </div>
      {error && <div role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}
      <button type="submit" className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !hydrated || !token}>Change password</button>
      {!token && <a className="btn btn--ghost" href="/login" style={{ justifyContent: 'center' }}>Back to sign in</a>}
    </form>
  );
}
