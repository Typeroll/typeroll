// The site overview after a handover (SiteSettings.handover).
//
// HandoverStartView: for people without design rights (editors, clients
// with a shared site): the checklist's progress (read-only), a prominent
// link to the start page's editor and the pages they edit.
// HandoverCard: for administrators and builders: a small card with the
// progress and a link to the handover settings.
//
// Rendered on the server (no client state); the copy is the portal's.

import { handoverProgress, type SiteHandover } from '@typeroll/shared';

export interface HandoverPageLink { id: string; title: string; path?: string }

export interface HandoverStartViewProps {
  siteId: string;
  siteName: string;
  handover: SiteHandover;
  /** The start page, when it still exists. */
  startPage?: HandoverPageLink | null;
  /** Pages the person edits, at most a screenful. */
  pages: HandoverPageLink[];
  /** The structure lock applies to this person. */
  locked: boolean;
}

const editorHref = (siteId: string, pageId: string) => `/app/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}`;

export function HandoverStartView({ siteId, siteName, handover, startPage, pages, locked }: HandoverStartViewProps) {
  const progress = handoverProgress(handover);
  const items = handover.checklist ?? [];
  return (
    <section className="card handover-start" data-handover-start aria-labelledby="handover-start-title" style={{ marginBottom: '1.5rem' }}>
      <h2 id="handover-start-title" style={{ fontSize: '1.25rem', margin: '0 0 0.25rem' }}>Welcome to {siteName}</h2>
      <p className="muted" style={{ margin: '0 0 1rem' }}>
        {locked ? "The site's structure is locked; you can edit text and images." : 'Edit the pages of your site here.'}
      </p>
      {startPage && (
        <p style={{ margin: '0 0 1.25rem' }}>
          <a className="btn" href={editorHref(siteId, startPage.id)} data-handover-start-page>Start editing {startPage.title}</a>
        </p>
      )}
      {progress.total > 0 && (
        <div style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Checklist <span className="muted text-sm">· {progress.done} of {progress.total} done</span></h3>
          <progress value={progress.done} max={progress.total} aria-label={`${progress.done} of ${progress.total} done`} style={{ width: '100%', maxWidth: 360 }} />
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
            {items.map(item => (
              <li key={item.id} data-checklist-item={item.id} style={{ padding: '0.2rem 0' }}>
                <span role="img" aria-label={item.done ? 'Done' : 'To do'}>{item.done ? '✓' : '○'}</span>{' '}
                {item.href ? <a href={item.href}>{item.label}</a> : item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pages.length > 0 && (
        <div>
          <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Your pages</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {pages.map(page => (
              <li key={page.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.4rem 0', borderTop: '1px solid var(--color-border)' }}>
                <a href={editorHref(siteId, page.id)}>{page.title || '(untitled)'}</a>
                {page.path && <span className="muted text-sm">{page.path}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function HandoverCard({ siteId, handover }: { siteId: string; handover: SiteHandover }) {
  const progress = handoverProgress(handover);
  return (
    <div className="card" data-handover-card style={{ marginBottom: '1.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between' }}>
      <div>
        <strong>Handover</strong>{' '}
        <span className="muted text-sm">
          {handover.handed_over_at ? `Handed over ${new Date(handover.handed_over_at).toLocaleDateString()}` : 'Being prepared'}
          {progress.total > 0 ? ` · ${progress.done} of ${progress.total} done` : ''}
          {handover.lock_structure ? ' · structure locked for editors' : ''}
        </span>
      </div>
      <a className="btn btn--secondary" href={`/app/sites/${encodeURIComponent(siteId)}/settings/handover`}>Edit handover</a>
    </div>
  );
}
