import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { CircleCheck, CircleX, Clock3, Layers } from 'lucide-react';
import './PublishingCard.css';

export type PublishingState = 'error' | 'waiting' | 'ready' | 'neutral';

export type PublishingTab = 'github' | 'cloudflare' | 'media' | 'builds' | 'hosting' | 'domains';

/** Maps a card id, or a link hash such as `media-title`, to its tab on the Publishing page. */
export function publishingTabFor(id: string): PublishingTab | null {
  const key = id.replace(/^loading-/, '').replace(/-title$/, '');
  if (key === 'publishing-builds' || key === 'builds') return 'builds';
  if (key === 'hosting' || key.startsWith('hosting-')) return 'hosting';
  return (['github', 'cloudflare', 'media', 'domains'] as const).find(tab => tab === key) ?? null;
}

/** Provided by PublishingTabs. Cards outside the Publishing page render as before. */
export const PublishingTabContext = createContext<{
  active: PublishingTab;
  report: (id: string, state: PublishingState | null) => void;
} | null>(null);

export const PublishingStateIcon = ({ state, size }: { state: PublishingState; size: number }) => {
  const Icon = state === 'neutral' ? Layers : state === 'ready' ? CircleCheck : state === 'waiting' ? Clock3 : CircleX;
  return <Icon size={size} strokeWidth={2} />;
};

export default function PublishingCard({ id, title, state, status, children }: {
  id: string; title: string; state: PublishingState; status: string; children: ReactNode;
}) {
  const tabs = useContext(PublishingTabContext);
  const report = tabs?.report;
  useEffect(() => {
    report?.(id, state);
    return () => report?.(id, null);
  }, [report, id, state]);
  const hidden = Boolean(tabs && publishingTabFor(id) !== tabs.active);
  return <section className="card publishing-card" aria-labelledby={`${id}-title`} data-state={state} hidden={hidden}>
    <header className="publishing-card__header">
      <span className={`publishing-card__symbol publishing-card__symbol--${state}`} aria-hidden="true"><PublishingStateIcon state={state} size={34} /></span>
      <div>
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="publishing-card__status" aria-live="polite">{status}</p>
      </div>
    </header>
    <div className="stack publishing-card__body">{children}</div>
  </section>;
}
