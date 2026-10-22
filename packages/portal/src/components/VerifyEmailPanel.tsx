import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  email: string;
  /** Sanitized same-origin continuation (invitation, MCP consent, app page). */
  next?: string | null;
  /** True when sign-up has just sent the first confirmation email. */
  sent?: boolean;
}

/** How often the page asks the server while it is visible, and for how long. */
export const CONFIRMATION_POLL_MS = 10_000;
export const CONFIRMATION_POLL_WINDOW_MS = 15 * 60_000;

async function post(path: string, body: unknown = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { verified?: boolean; error?: string };
  return { response, data };
}

/**
 * Only the server knows whether the address is confirmed, so the page asks it:
 * when it opens (also after the confirmation link brings the person back),
 * whenever the tab becomes visible again, and every few seconds while it is
 * visible. Once confirmed it continues without any action from the person.
 */
export default function VerifyEmailPanel({ email, next = null, sent = false }: Props) {
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [emailSent, setEmailSent] = useState(sent);
  const checking = useRef(false);
  const stopped = useRef(false);
  const startedAt = useRef(Date.now());

  const continueOn = useCallback(() => { stopped.current = true; window.location.href = next ?? '/app'; }, [next]);

  const check = useCallback(async () => {
    if (checking.current || stopped.current) return;
    checking.current = true;
    try {
      const { response, data } = await post('/api/auth/verification-status');
      if (response.ok && data.verified) { continueOn(); return; }
      if (response.status === 401) {
        stopped.current = true;
        setError('Your sign-in has expired. Sign out and sign in again.');
      }
      // Not confirmed yet, rate limited or a transient failure: stay quiet and
      // ask again on the next tick or when the tab is shown.
    } catch { /* offline: the next tick tries again */ }
    finally { checking.current = false; }
  }, [continueOn]);

  useEffect(() => {
    setHydrated(true);
    void check();
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - startedAt.current > CONFIRMATION_POLL_WINDOW_MS) return;
      void check();
    }, CONFIRMATION_POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(timer);
    };
  }, [check]);

  async function send() {
    if (sending) return;
    setSending(true); setError(null); setNotice(null);
    try {
      const { response, data } = await post('/api/auth/verification-email', { next });
      if (data.verified) { continueOn(); return; }
      if (response.ok) {
        setEmailSent(true);
        startedAt.current = Date.now();
        setNotice(`We sent a confirmation link to ${email}. It can take a few minutes to arrive.`);
        return;
      }
      setError(response.status === 429
        ? 'Too many attempts. Please wait a few minutes and try again.'
        : response.status === 401 ? 'Your sign-in has expired. Sign out and sign in again.'
        : 'Could not send a confirmation email. Please try again later.');
    } catch {
      setError('Could not connect. Check your connection and try again.');
    } finally { setSending(false); }
  }

  return (
    <div className="stack" data-verify-ready={hydrated ? 'true' : 'false'}>
      <p>
        {emailSent ? 'We sent a confirmation link to ' : 'Confirm your email address to continue: '}
        <strong style={{ overflowWrap: 'anywhere' }}>{email || 'your account'}</strong>.
        {emailSent
          ? ' Open the link in that email. This page continues by itself once the address is confirmed.'
          : ' Send yourself a confirmation link and open it from your inbox. This page continues by itself once the address is confirmed.'}
      </p>
      <p className="muted text-sm">
        Until your email is confirmed, you cannot create or join an organization, accept invitations,
        use API keys or connect AI tools. Organizations you already belong to are kept.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <div role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}
      <button type="button" className={emailSent ? 'btn btn--secondary' : 'btn'} style={{ width: '100%', justifyContent: 'center' }} disabled={!hydrated || sending} onClick={send}>
        {sending ? 'Sending…' : emailSent ? 'Resend confirmation email' : 'Send confirmation email'}
      </button>
      <p className="muted text-sm">Can't find it? Check your spam folder, or sign out and use a different account.</p>
      <form method="POST" action="/api/auth/logout">
        <button type="submit" className="btn btn--ghost" style={{ width: '100%', justifyContent: 'center' }}>Sign out</button>
      </form>
    </div>
  );
}
