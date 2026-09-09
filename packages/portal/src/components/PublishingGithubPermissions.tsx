import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { GithubPermissions } from '../lib/publishing/github-permissions';

export default function PublishingGithubPermissions({ revision }: { revision: string }) {
  const [result, setResult] = useState<GithubPermissions | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const waiting = useRef(false), inFlight = useRef(false), generation = useRef(0);
  async function check() {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/orgs/publishing/github/permissions', { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not check GitHub permissions. Try again.');
      if (current !== generation.current) return;
      if (value.revision !== revision) throw Error('The GitHub connection changed. Refresh this page and check again.');
      setResult(value);
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : 'Could not check GitHub permissions. Try again.');
    } finally {
      if (current === generation.current) { inFlight.current = false; setBusy(false); }
    }
  }
  useEffect(() => {
    generation.current++; inFlight.current = false; waiting.current = false; setResult(null); void check();
    return () => { generation.current++; };
  }, [revision]);
  useEffect(() => {
    const returned = () => {
      if (waiting.current && !inFlight.current && document.visibilityState === 'visible') { waiting.current = false; void check(); }
    };
    window.addEventListener('focus', returned); document.addEventListener('visibilitychange', returned);
    return () => { window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', returned); };
  }, [revision]);
  return <div aria-busy={busy}>
    {result?.state === 'approval_required' && result.approval_url && <p><a className="btn" href={result.approval_url} target="_blank" rel="noopener noreferrer" onClick={() => { waiting.current = true; }}>Approve GitHub update <ExternalLink size={16} aria-hidden="true" /></a></p>}
    <button className="btn btn--secondary" type="button" disabled={busy} onClick={() => void check()}>{busy ? 'Checking GitHub permissions…' : 'Check GitHub permissions'}</button>
    {error ? <p role="alert">{error}</p> : <p role="status">{busy ? 'Checking the existing GitHub connection…' : result?.message}</p>}
  </div>;
}
