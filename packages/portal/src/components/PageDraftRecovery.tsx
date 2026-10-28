import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkingCopy } from '@typeroll/shared';
import './PageDraftRecovery.css';

/** Keep the editor (including autosave and its draft preview) unmounted until a choice is made. */
export default function PageDraftRecovery({ siteId, pageId, workingCopy, children }: {
  siteId: string;
  pageId: string;
  workingCopy?: WorkingCopy | null;
  children: (copy: WorkingCopy | null) => ReactNode;
}) {
  const [chosen, setChosen] = useState(!workingCopy);
  const [copy, setCopy] = useState(workingCopy ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!chosen) heading.current?.focus();
  }, [chosen]);
  useEffect(() => {
    // Back/forward-cache restores React state without loading the server-side
    // working copy. Re-enter through the same recovery choice in that case too.
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  async function openSaved() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/working-copy/page/${encodeURIComponent(pageId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not discard the autosaved draft. Please try again.');
      setCopy(null);
      setChosen(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (chosen) return <>{children(copy)}</>;
  return <section className="draft-recovery" aria-labelledby="draft-recovery-title">
    <h2 id="draft-recovery-title" ref={heading} tabIndex={-1}>Continue your autosaved draft?</h2>
    <p>This page has changes that were autosaved but not saved to the CMS. Choose which version to edit.</p>
    <div className="draft-recovery__choices">
      <div><h3>Autosaved draft</h3><p>Continue your unfinished changes. The saved page stays unchanged until you choose Save.</p>
        <button type="button" disabled={busy} onClick={() => setChosen(true)}>Continue autosaved draft</button></div>
      <div><h3>Last saved version</h3><p>Discard the autosaved draft and open the last version explicitly saved in the CMS. This may differ from the live website.</p>
        <button type="button" disabled={busy} onClick={() => void openSaved()}>{busy ? 'Opening saved version…' : 'Discard draft and open saved version'}</button></div>
    </div>
    {error && <p role="alert">{error}</p>}
    <a href={`/app/sites/${siteId}/pages`}>Back to pages</a>
  </section>;
}
