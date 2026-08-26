import { useEffect, useRef, useState } from 'react';
import type { Site } from '@typeroll/shared';

interface Props {
  sites: Site[];
  currentSiteId?: string;
}

// The dot + label used to come from Site.status, a lifecycle field that was
// written once at creation and never advanced — every site showed "Planning"
// forever, including ones serving production traffic. Removed in 0.30.0; this
// now reflects the domain lifecycle, which is maintained.
//
// Duplicated from lib/site-public-urls.ts rather than imported: this is a
// client component and that module pulls in server-side URL helpers.
type DomainState = 'live' | 'pending' | 'failed' | 'none';

function domainStateOf(site: { domain?: string; domain_status?: string }): DomainState {
  if (!site.domain) return 'none';
  if (site.domain_status === 'verified' || site.domain_status === 'live') return 'live';
  if (site.domain_status === 'failed') return 'failed';
  return 'pending';
}

const STATUS_LABEL: Record<DomainState, string> = {
  live: 'Live',
  pending: 'DNS pending',
  failed: 'DNS failed',
  none: 'No domain',
};

export default function SiteSwitcher({ sites, currentSiteId }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = sites.find((s) => s.id === currentSiteId);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function go(siteId: string) {
    if (siteId === currentSiteId) {
      setOpen(false);
      return;
    }
    // Full reload: every per-site context resets cleanly, lands on the site dashboard.
    window.location.href = `/app/sites/${siteId}`;
  }

  return (
    <div className="ws" ref={ref}>
      <button
        type="button"
        className="ws__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ws__label">Site</span>
        <span className="ws__current">
          {current ? (
            <>
              <span className={`ws__dot ws__dot--${domainStateOf(current)}`} aria-hidden />
              <span className="ws__name">{current.name}</span>
            </>
          ) : (
            <>
              <span className="ws__dot ws__dot--empty" aria-hidden />
              <span className="ws__name ws__name--placeholder">All sites</span>
            </>
          )}
          <svg className="ws__chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        {current?.domain && <span className="ws__meta">{current.domain}</span>}
      </button>

      {open && (
        <div className="ws__menu" role="listbox" aria-label="Switch site">
          <div className="ws__menu-label">Sites</div>
          {sites.length === 0 ? (
            <div className="ws__empty">No sites yet</div>
          ) : (
            sites.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === currentSiteId}
                className={`ws__item ${s.id === currentSiteId ? 'ws__item--active' : ''}`}
                onClick={() => go(s.id)}
              >
                <span className={`ws__dot ws__dot--${domainStateOf(s)}`} aria-hidden />
                <span className="ws__item-body">
                  <span className="ws__item-name">{s.name}</span>
                  <span className="ws__item-meta">
                    {s.domain ?? 'no domain'}
                    <span className="ws__sep">·</span>
                    {STATUS_LABEL[domainStateOf(s)]}
                  </span>
                </span>
                {s.id === currentSiteId && (
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                    <path d="M3 7.5l2.8 2.8L11 5" stroke="currentColor" strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))
          )}
          <a href="/app/sites/new" className="ws__new">
            <span className="ws__new-icon" aria-hidden>+</span>
            New site
          </a>
        </div>
      )}
    </div>
  );
}
