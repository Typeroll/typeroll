import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { PublishingStateIcon, PublishingTabContext, publishingTabFor, type PublishingState, type PublishingTab } from './PublishingCard';
import PublishingConnections from './PublishingConnections';
import PublishingBuilds from './PublishingBuilds';
import HostingGroups from './HostingGroups';
import PublishingDomains from './PublishingDomains';
import './PublishingTabs.css';

const TABS: Array<{ id: PublishingTab; label: string }> = [
  { id: 'github', label: 'GitHub' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'builds', label: 'Builds' },
  { id: 'hosting', label: 'Hosting Groups' },
  { id: 'domains', label: 'Domains' },
];
const CONNECTION_TABS: PublishingTab[] = ['github', 'cloudflare'];
const RANK: PublishingState[] = ['error', 'waiting', 'ready', 'neutral'];
const STATUS_TEXT: Record<PublishingState, string> = { error: 'Needs attention', waiting: 'In progress', ready: 'Ready', neutral: 'No setup needed' };

/** The organization Publishing page, one tab per setup area. Panels stay mounted so polling and OAuth returns keep working. */
export default function PublishingTabs({ initialTab = 'github', refreshAfterCloudflareReturn = false }: {
  initialTab?: PublishingTab; refreshAfterCloudflareReturn?: boolean;
}) {
  const [active, setActive] = useState<PublishingTab>(initialTab);
  const [states, setStates] = useState<Record<string, PublishingState>>({});
  const tabRefs = useRef<Partial<Record<PublishingTab, HTMLButtonElement | null>>>({});
  const scrollTarget = useRef<string | null>(null);
  const report = useCallback((id: string, state: PublishingState | null) => setStates(current => {
    if ((current[id] ?? null) === state) return current;
    const next = { ...current };
    if (state) next[id] = state; else delete next[id];
    return next;
  }), []);
  const context = useMemo(() => ({ active, report }), [active, report]);

  // Links such as /app/settings/publishing#publishing-builds open the matching tab.
  useEffect(() => {
    const follow = () => {
      const hash = decodeURIComponent(window.location.hash.slice(1));
      const tab = hash ? publishingTabFor(hash) : null;
      if (!tab) return;
      scrollTarget.current = hash;
      setActive(tab);
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  useEffect(() => {
    const target = scrollTarget.current;
    if (!target) return;
    scrollTarget.current = null;
    (document.getElementById(target) ?? document.getElementById(`${target}-title`))?.scrollIntoView({ block: 'start' });
  }, [active]);

  function select(tab: PublishingTab, focus = false) {
    setActive(tab);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${tab}`);
    if (focus) tabRefs.current[tab]?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex(tab => tab.id === active);
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
      : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    select(TABS[next].id, true);
  }
  function tabState(tab: PublishingTab): PublishingState {
    const found = Object.entries(states).filter(([id]) => publishingTabFor(id) === tab).map(([, state]) => state);
    if (!found.length) return 'waiting';
    return RANK.find(state => found.includes(state)) ?? 'neutral';
  }
  const panel = (tab: PublishingTab) => ({ role: 'tabpanel', id: `publishing-panel-${tab}`, 'aria-labelledby': `publishing-tab-${tab}`, hidden: active !== tab });

  return <PublishingTabContext.Provider value={context}>
    <div className="publishing-tabs" role="tablist" aria-label="Publishing setup" onKeyDown={onKeyDown}>
      {TABS.map(tab => {
        const state = tabState(tab.id);
        const selected = tab.id === active;
        return <button key={tab.id} ref={element => { tabRefs.current[tab.id] = element; }} type="button" role="tab"
          id={`publishing-tab-${tab.id}`} aria-selected={selected} tabIndex={selected ? 0 : -1}
          aria-controls={CONNECTION_TABS.includes(tab.id) ? 'publishing-panel-connections' : `publishing-panel-${tab.id}`}
          className="publishing-tabs__tab" data-state={state} onClick={() => select(tab.id)}>
          <span className={`publishing-tabs__symbol publishing-card__symbol--${state}`} aria-hidden="true"><PublishingStateIcon state={state} size={14} /></span>
          <span>{tab.label}</span>
          <span className="publishing-tabs__status">{`, ${STATUS_TEXT[state]}`}</span>
        </button>;
      })}
    </div>
    <div role="tabpanel" id="publishing-panel-connections" aria-labelledby={`publishing-tab-${active}`} hidden={!CONNECTION_TABS.includes(active)}>
      <PublishingConnections />
    </div>
    <div {...panel('builds')}><PublishingBuilds refreshAfterCloudflareReturn={refreshAfterCloudflareReturn} /></div>
    <div {...panel('hosting')}><HostingGroups /></div>
    <div {...panel('domains')}><PublishingDomains /></div>
  </PublishingTabContext.Provider>;
}
