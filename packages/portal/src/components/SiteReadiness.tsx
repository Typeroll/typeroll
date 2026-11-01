/**
 * Compact launch readiness panel on the site overview. Loaded on demand so
 * the overview stays fast: the report reads all saved content and may ask
 * Cloudflare about the zone's AI crawler settings.
 */
import { useState } from 'react';

interface Item {
  id: string;
  status: 'ok' | 'suggestion' | 'warning';
  message: string;
  fix: string;
  guide: string;
  details?: string[];
}
interface Report {
  checked_at: string;
  summary: { ok: number; suggestions: number; warnings: number };
  items: Item[];
}

const COLOR: Record<Item['status'], string> = {
  warning: 'var(--color-danger)',
  suggestion: '#c68a14',
  ok: 'var(--color-success)',
};
const LABEL: Record<Item['status'], string> = { warning: 'Warning', suggestion: 'Suggestion', ok: 'OK' };

export default function SiteReadiness({ siteId }: { siteId: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOk, setShowOk] = useState(false);

  async function check() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/readiness`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not check readiness');
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check readiness');
    } finally {
      setLoading(false);
    }
  }

  const open = report?.items.filter(item => item.status !== 'ok') ?? [];
  const passed = report?.items.filter(item => item.status === 'ok') ?? [];
  return (
    <div className="card" style={{ marginTop: '1.5rem' }} data-site-readiness>
      <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div>
          <h2 style={{ fontSize: '1.125rem', margin: 0 }}>Launch readiness</h2>
          <p className="muted text-sm" style={{ margin: '0.25rem 0 0' }}>
            {report
              ? `${report.summary.warnings} warnings, ${report.summary.suggestions} suggestions, ${report.summary.ok} OK. Nothing here blocks publishing.`
              : 'Checks what the site needs to be found, shared and understood. Nothing here blocks publishing.'}
          </p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={check} disabled={loading}>
          {loading ? 'Checking…' : report ? 'Check again' : 'Check readiness'}
        </button>
      </div>
      {error && <p className="text-sm" role="alert" style={{ color: 'var(--color-danger)', marginBottom: 0 }}>{error}</p>}
      {report && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
          {[...open, ...(showOk ? passed : [])].map(item => (
            <li key={item.id} style={{ padding: '0.6rem 0', borderTop: '1px solid var(--color-border)' }}>
              <div className="text-sm">
                <strong style={{ color: COLOR[item.status] }}>{LABEL[item.status]}</strong>{' '}
                {item.message}
              </div>
              {item.status !== 'ok' && (
                <div className="muted text-sm" style={{ marginTop: '0.2rem' }}>
                  {item.fix}{' '}
                  <a href={item.guide} target="_blank" rel="noopener">Guide</a>
                </div>
              )}
              {item.status !== 'ok' && item.details?.length ? (
                <details className="text-sm" style={{ marginTop: '0.25rem' }}>
                  <summary>{item.details.length === 1 ? '1 detail' : `${item.details.length} details`}</summary>
                  <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem' }}>
                    {item.details.map(detail => <li key={detail}>{detail}</li>)}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {report && passed.length > 0 && (
        <button type="button" className="btn btn--secondary" style={{ marginTop: '0.75rem' }} onClick={() => setShowOk(value => !value)}>
          {showOk ? 'Hide passed checks' : `Show ${passed.length} passed checks`}
        </button>
      )}
    </div>
  );
}
