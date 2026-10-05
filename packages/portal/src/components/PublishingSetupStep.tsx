import type { ReactNode } from 'react';
import { CircleCheck, CircleX, Clock3 } from 'lucide-react';
import type { PublishingState } from './PublishingCard';

/** One numbered step of a provider connection card (`data-github-step`, `data-cloudflare-step`). */
export default function PublishingSetupStep({ provider, id, title, state, status, children }: {
  provider: 'github' | 'cloudflare'; id: string; title: string; state: PublishingState; status: string; children?: ReactNode;
}) {
  const Icon = state === 'ready' ? CircleCheck : state === 'error' ? CircleX : Clock3;
  const heading = `${provider}-step-${id}`;
  return <li className="publishing-setup-step" {...{ [`data-${provider}-step`]: id }} data-state={state} aria-labelledby={heading}>
    <header className="publishing-setup-step__header">
      <span className={`publishing-card__symbol publishing-card__symbol--${state}`} aria-hidden="true"><Icon size={28} /></span>
      <div><h3 id={heading}>{title}</h3><p>{status}</p></div>
    </header>
    {children}
  </li>;
}
