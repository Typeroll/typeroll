import { useEffect, useState } from 'react';

interface Props {
  email: string;
  /** Sanitized same-origin continuation (invitation, MCP consent, app page). */
  next?: string | null;
  /** True when sign-up has just sent the first confirmation email. */
  sent?: boolean;
}

type Busy = 'resend' | 'check' | null;

async function post(path: string, body: unknown = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { verified?: boolean; error?: string };
  return { response, data };
}

export default function VerifyEmailPanel({ email, next = null, sent = false }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [emailSent, setEmailSent] = useState(sent);

  useEffect(() => setHydrated(true), []);

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(kind); setError(null); setNotice(null);
    try { await fn(); }
    catch { setError('Could not connect. Check your connection and try again.'); }
    finally { setBusy(null); }
  }

  const resend = () => run('resend', async () => {
    const { response, data } = await post('/api/auth/verification-email', { next });
    if (data.verified) { window.location.href = next ?? '/app'; return; }
    if (response.ok) {
      setEmailSent(true);
      setNotice(`We sent a new confirmation link to ${email}. It can take a few minutes to arrive.`);
      return;
    }
    setError(response.status === 429
      ? 'Too many attempts. Please wait a few minutes and try again.'
      : response.status === 401 ? 'Your sign-in has expired. Sign out and sign in again.'
      : 'Could not send a confirmation email. Please try again later.');
  });

  const check = () => run('check', async () => {
    const { response, data } = await post('/api/auth/verification-status');
    if (response.ok && data.verified) { window.location.href = next ?? '/app'; return; }
    if (response.ok) {
      setError('Your email address is not confirmed yet. Open the link in the email, then try again.');
      return;
    }
    setError(response.status === 429
      ? 'Too many attempts. Please wait a few minutes and try again.'
      : response.status === 401 ? 'Your sign-in has expired. Sign out and sign in again.'
      : 'Could not check your email confirmation. Please try again shortly.');
  });

  return (
    <div className="stack" data-verify-ready={hydrated ? 'true' : 'false'}>
      <p>
        {emailSent ? 'We sent a confirmation link to ' : 'Confirm your email address to continue: '}
        <strong style={{ overflowWrap: 'anywhere' }}>{email || 'your account'}</strong>.
        {emailSent ? ' Open the link in that email, then return here.' : ' Send a confirmation link and open it from your inbox.'}
      </p>
      <p className="muted text-sm">
        Until your email is confirmed, you cannot create or join an organization, accept invitations,
        use API keys or connect AI tools. Organizations you already belong to are kept.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <div role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}
      <button type="button" className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={!hydrated || busy !== null} onClick={check}>
        {busy === 'check' ? 'Checking…' : "I've confirmed my email"}
      </button>
      <button type="button" className="btn btn--secondary" style={{ width: '100%', justifyContent: 'center' }} disabled={!hydrated || busy !== null} onClick={resend}>
        {busy === 'resend' ? 'Sending…' : emailSent ? 'Resend confirmation email' : 'Send confirmation email'}
      </button>
      <p className="muted text-sm">Can't find it? Check your spam folder, or sign out and use a different account.</p>
      <form method="POST" action="/api/auth/logout">
        <button type="submit" className="btn btn--ghost" style={{ width: '100%', justifyContent: 'center' }}>Sign out</button>
      </form>
    </div>
  );
}
