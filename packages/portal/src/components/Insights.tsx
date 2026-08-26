// The Insights dashboard (Analytics core module). Traffic + AI-assistant referral
// breakdown from Cloudflare Web Analytics. Every "no data yet" condition is
// a friendly explained state, not an error — the Analytics module can be
// enabled before it's fully wired to a CF site.

import { useEffect, useState } from 'react';

interface RefererRow { referer: string; visits: number; pageviews: number }
interface AiReferral {
  by_assistant: Array<{ key: string; label: string; visits: number; pageviews: number }>;
  total_ai_visits: number;
  total_ai_pageviews: number;
}
interface Insights {
  status: 'ok' | 'app_disabled' | 'not_configured' | 'no_site_tag' | 'no_data';
  days: number;
  total_visits: number;
  total_pageviews: number;
  top_referrers: RefererRow[];
  ai_referrals: AiReferral;
  conversions: {
    total_events: number;
    by_event: Array<{ name: string; destination: string; count: number }>;
    by_source: Array<{ source: string; count: number }>;
    by_campaign: Array<{ campaign: string; count: number }>;
    truncated: boolean;
  };
}

const RANGES = [7, 30, 90];
const EMPTY_CONVERSIONS: Insights['conversions'] = {
  total_events: 0,
  by_event: [],
  by_source: [],
  by_campaign: [],
  truncated: false,
};

const STATUS_NOTE: Record<Insights['status'], string> = {
  ok: '',
  app_disabled: 'The Analytics module is off for this site. Enable it under Settings → Core modules.',
  not_configured: 'Cloudflare analytics isn’t configured on this server yet. Stats will appear once it is.',
  no_site_tag: 'Analytics is on, but not yet linked to a Cloudflare Web Analytics site. Add the token/site tag under Settings → Core modules, then redeploy.',
  no_data: 'No visits recorded yet for this period. Data appears after your site gets traffic (allow a few minutes after deploy).',
};

export default function Insights({ siteId }: { siteId: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/sites/${siteId}/insights?days=${days}`)
      .then((r) => r.json())
      .then((d: Insights) => setData({ ...d, conversions: d.conversions ?? EMPTY_CONVERSIONS }))
      .finally(() => setLoading(false));
  }, [siteId, days]);

  const maxAi = Math.max(1, ...(data?.ai_referrals.by_assistant.map((a) => a.visits) ?? [1]));

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className={r === days ? 'btn btn--primary' : 'btn btn--ghost'}
            onClick={() => setDays(r)}
          >
            {r} days
          </button>
        ))}
      </div>

      {loading && <p className="muted">Loading…</p>}

      {!loading && data && data.status !== 'ok' && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>{STATUS_NOTE[data.status]}</p>
          {data.status === 'app_disabled' && (
            <p style={{ margin: '0.5rem 0 0' }}>
              <a href={`/app/sites/${siteId}/settings/apps`} className="btn btn--primary">Manage modules →</a>
            </p>
          )}
        </div>
      )}

      {!loading && data && data.status === 'ok' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
            <Stat label="Visits" value={data.total_visits} />
            <Stat label="Page views" value={data.total_pageviews} />
            <Stat label="AI-assistant visits" value={data.ai_referrals.total_ai_visits} accent />
          </div>

          <section className="card stack" style={{ gap: '0.75rem' }}>
            <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Visits from AI assistants</h2>
            {data.ai_referrals.by_assistant.length === 0 ? (
              <p className="muted text-sm" style={{ margin: 0 }}>
                No AI-assistant referrals in this period yet. As ChatGPT, Claude, Perplexity and
                others cite your pages, they’ll show up here.
              </p>
            ) : (
              <div className="stack" style={{ gap: '0.4rem' }}>
                {data.ai_referrals.by_assistant.map((a) => (
                  <div key={a.key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 3rem', alignItems: 'center', gap: '0.5rem' }}>
                    <span className="text-sm" style={{ fontWeight: 600 }}>{a.label}</span>
                    <span style={{ background: 'var(--accent-soft, #eef2ff)', borderRadius: 4, height: 18, overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: '100%', width: `${(a.visits / maxAi) * 100}%`, background: 'var(--accent, #6366f1)' }} />
                    </span>
                    <span className="text-sm" style={{ textAlign: 'right' }}>{a.visits}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card stack" style={{ gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Top referrers</h2>
            {data.top_referrers.length === 0 ? (
              <p className="muted text-sm" style={{ margin: 0 }}>No referrers in this period.</p>
            ) : (
              <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                    <th style={{ padding: '0.25rem 0' }}>Source</th>
                    <th style={{ textAlign: 'right' }}>Visits</th>
                    <th style={{ textAlign: 'right' }}>Page views</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_referrers.map((r) => (
                    <tr key={r.referer} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                      <td style={{ padding: '0.3rem 0' }}>{r.referer}</td>
                      <td style={{ textAlign: 'right' }}>{r.visits}</td>
                      <td style={{ textAlign: 'right' }}>{r.pageviews}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="muted text-sm" style={{ margin: 0 }}>
            Privacy-friendly and cookieless, powered by Cloudflare Web Analytics.
          </p>
        </>
      )}

      {!loading && data && data.status !== 'app_disabled' && (
        <section className="card stack" style={{ gap: '0.75rem' }}>
          <div>
            <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Conversions</h2>
            <p className="muted text-sm" style={{ margin: '0.25rem 0 0' }}>
              First-party events from Analytics attribution funnels.
            </p>
          </div>
          <Stat label="Conversion events" value={data.conversions.total_events} accent />
          {data.conversions.by_event.length === 0 ? (
            <p className="muted text-sm" style={{ margin: 0 }}>No conversion events in this period.</p>
          ) : (
            <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                  <th style={{ padding: '0.25rem 0' }}>Event</th>
                  <th>Destination</th>
                  <th style={{ textAlign: 'right' }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {data.conversions.by_event.map((event) => (
                  <tr key={`${event.name}:${event.destination}`} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                    <td style={{ padding: '0.3rem 0' }}>{event.name}</td>
                    <td>{event.destination}</td>
                    <td style={{ textAlign: 'right' }}>{event.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.conversions.by_source.length > 0 && (
            <p className="muted text-sm" style={{ margin: 0 }}>
              Top sources: {data.conversions.by_source.map((source) => `${source.source} (${source.count})`).join(', ')}
            </p>
          )}
          {data.conversions.by_campaign.length > 0 && (
            <p className="muted text-sm" style={{ margin: 0 }}>
              Top campaigns: {data.conversions.by_campaign.map((campaign) => `${campaign.campaign} (${campaign.count})`).join(', ')}
            </p>
          )}
          {data.conversions.truncated && (
            <p className="muted text-sm" style={{ margin: 0 }}>
              Showing the first 5,000 events in this period.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="card" style={{ padding: '0.9rem 1rem' }}>
      <div className="text-sm muted">{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, color: accent ? 'var(--accent, #6366f1)' : undefined }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}
