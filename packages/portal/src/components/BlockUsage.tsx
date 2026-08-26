import { useEffect, useState } from 'react';

interface UsagePage {
  page_id: string;
  title: string;
  slug: string;
  status: string;
}

interface UsageResponse {
  partial_id: string;
  auto_injected: boolean;
  pages: UsagePage[];
}

interface Props {
  siteId: string;
  partialId: string;
  /** Header/footer report differently in copy ("auto-injected on every page"
   *  vs. "Used on N pages"); the parent already knows the kind, so it's
   *  cheaper to pass it than to wait on the fetch to decide UI shape. */
  kind: 'header' | 'footer' | 'free';
}

/**
 * "Used on N pages" pill for the partial editor. Lazy-fetches on mount and
 * expands to a clickable list of titles. The accompanying callout reminds
 * the editor that a save here propagates to every listed page.
 */
export default function BlockUsage({ siteId, partialId, kind }: Props) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sites/${siteId}/partials/${partialId}/usage`);
        const j = (await res.json()) as UsageResponse | { error: string };
        if (cancelled) return;
        if (!res.ok || 'error' in j) {
          setError('error' in j ? j.error : `Lookup failed (${res.status})`);
          return;
        }
        setData(j);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Lookup failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteId, partialId]);

  if (error) {
    return <div className="block-usage block-usage--err">Couldn't load usage: {error}</div>;
  }
  if (!data) {
    return <div className="block-usage block-usage--loading">Counting pages that use this block…</div>;
  }

  const count = data.pages.length;
  const auto = data.auto_injected;
  const label = auto
    ? `Auto-injected on every page (${count})`
    : `Used on ${count} page${count === 1 ? '' : 's'}`;
  const calloutCopy = auto
    ? `Every page on the site shows this ${kind}. Edits here update them all.`
    : count === 0
    ? `No pages embed this block yet. Add <x-include name="${partialId}" /> to any page to start using it.`
    : `Edits here will update ${count} page${count === 1 ? '' : 's'}.`;

  return (
    <div className="block-usage">
      <button
        type="button"
        className="block-usage__pill"
        onClick={() => setOpen((v) => !v)}
        disabled={count === 0}
      >
        <span className="block-usage__count">{count}</span>
        <span>{label}</span>
        {count > 0 && <span className="block-usage__caret">{open ? '▾' : '▸'}</span>}
      </button>
      <p className="block-usage__callout">{calloutCopy}</p>
      {open && count > 0 && (
        <ul className="block-usage__list">
          {data.pages.map((p) => (
            <li key={p.page_id}>
              <a href={`/app/sites/${siteId}/pages/${p.page_id}`} target="_blank" rel="noopener">
                {p.title || p.slug || p.page_id}
                <span className="block-usage__slug">/{p.slug}</span>
                {p.status && p.status !== 'published' && (
                  <span className="block-usage__status">{p.status}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      <style>{styles}</style>
    </div>
  );
}

const styles = `
.block-usage { display: flex; flex-direction: column; gap: 0.35rem; }
.block-usage--loading,
.block-usage--err {
  font-size: 0.8rem; color: var(--color-text-muted);
}
.block-usage--err { color: var(--color-danger); }
.block-usage__pill {
  display: inline-flex; align-items: center; gap: 0.4rem;
  align-self: flex-start;
  padding: 0.2rem 0.6rem 0.2rem 0.35rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--color-text);
  cursor: pointer;
}
.block-usage__pill:disabled { cursor: default; color: var(--color-text-muted); }
.block-usage__pill:hover:not(:disabled) { background: var(--color-bg); }
.block-usage__count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.25rem; height: 1.25rem; padding: 0 0.35rem;
  border-radius: 999px;
  background: var(--color-primary); color: white;
  font-size: 0.7rem; font-weight: 600;
}
.block-usage__caret { font-size: 0.65rem; color: var(--color-text-muted); }
.block-usage__callout {
  margin: 0; font-size: 0.78rem; color: var(--color-text-muted);
}
.block-usage__list {
  margin: 0.15rem 0 0; padding: 0; list-style: none;
  display: flex; flex-direction: column; gap: 0.15rem;
  border-top: 1px dashed var(--color-border);
  padding-top: 0.4rem;
}
.block-usage__list a {
  display: inline-flex; align-items: baseline; gap: 0.4rem;
  font-size: 0.85rem;
}
.block-usage__slug { color: var(--color-text-muted); font-family: var(--font-mono); font-size: 0.75rem; }
.block-usage__status {
  font-size: 0.7rem; padding: 0 0.35rem; border-radius: 4px;
  background: var(--color-bg); color: var(--color-text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
`;
