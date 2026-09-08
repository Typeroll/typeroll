import type { ReactNode } from 'react';
import { CircleCheck, CircleX, Clock3 } from 'lucide-react';
import './PublishingCard.css';

export type PublishingState = 'error' | 'waiting' | 'ready';

export default function PublishingCard({ id, title, state, status, children }: {
  id: string; title: string; state: PublishingState; status: string; children: ReactNode;
}) {
  const Icon = state === 'ready' ? CircleCheck : state === 'waiting' ? Clock3 : CircleX;
  return <section className="card publishing-card" aria-labelledby={`${id}-title`} data-state={state}>
    <header className="publishing-card__header">
      <span className={`publishing-card__symbol publishing-card__symbol--${state}`} aria-hidden="true"><Icon size={34} strokeWidth={2} /></span>
      <div>
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="publishing-card__status" aria-live="polite">{status}</p>
      </div>
    </header>
    <div className="stack publishing-card__body">{children}</div>
  </section>;
}
