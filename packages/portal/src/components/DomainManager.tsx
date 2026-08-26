// Custom-domain UI — domain-first model.
//
// The order is deliberately: (1) you DECLARE the domain you intend to use,
// (2) we immediately republish with it baked in as the canonical host
// (sitemap + <link rel=canonical> + robots), (3) you point your DNS at us
// LAST. There is no separate "activate" step — declaring the domain is what
// makes it canonical. This is what keeps the internal *.sites fallback from
// ever leaking into a public sitemap/canonical.
//
//   no domain  → POST /domain { hostname, auto_deploy } → domain set (+ republish)
//   any state  → POST /domain/poll                      → refresh DNS health
//   any state  → DELETE /domain                         → remove
//
// `status` (pending/verified/failed) is a DNS-HEALTH diagnostic ONLY — the
// domain is the canonical URL regardless of it. It just tells the customer
// whether their DNS change has landed yet. The component fetches GET /domain
// on mount and re-fetches after every mutation.

import { useEffect, useMemo, useState } from 'react';
import { classifyHostname, pickCanonical } from '../lib/domain-pair';

interface AliasState {
  hostname: string;
  status: 'pending' | 'verified' | 'live' | 'failed';
  failure_reason: string | null;
}

interface DomainState {
  hostname: string;
  status: 'pending' | 'verified' | 'live' | 'failed';
  dns_target: string;
  verified_at: string | null;
  failure_reason: string | null;
  alias?: AliasState | null;
  canonical_kind?: 'apex' | 'www';
}

interface Props {
  siteId: string;
  /** Where the customer can preview the site while DNS is being set up.
   *  Passed in from the Astro page so we don't need to fetch the site doc. */
  fallbackUrl?: string;
}

export default function DomainManager({ siteId, fallbackUrl }: Props) {
  const [state, setState] = useState<DomainState | null | undefined>(undefined);  // undefined = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // Default to apex-as-canonical (modern best practice; matches the
  // server's default). Customers can flip for the apex/www pair flow.
  const [prefer, setPrefer] = useState<'apex' | 'www'>('apex');
  // Publish-on-declare is on by default — the canonical URL is baked into the
  // build, so declaring a domain only takes effect for search engines once we
  // republish. Customers can opt out (e.g. unpublished drafts they don't want
  // to ship yet) and deploy later from the deploy panel.
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [deployJob, setDeployJob] = useState<{ job_id?: string; error?: string } | null>(null);

  // Live classification of the input so we can render the "we'll register
  // BOTH apex + www" preview before the user clicks submit. The server
  // does this authoritatively; this is just the UI mirror.
  const inputPick = useMemo(() => {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const classification = classifyHostname(trimmed);
    if (classification.kind === 'subdomain' && !classification.apex) {
      // Either an invalid input or a real subdomain (app.example.com,
      // example.co.uk-style). Either way no pair preview.
      return null;
    }
    return pickCanonical(trimmed, prefer);
  }, [input, prefer]);

  // Initial fetch.
  useEffect(() => { void load(); }, []);

  async function load() {
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/domain`);
      if (!res.ok) throw new Error(`Failed to load domain (${res.status})`);
      const body = await res.json() as { domain: DomainState | null };
      setState(body.domain);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState(null);
    }
  }

  async function callApi(path: string, init?: RequestInit): Promise<DomainState | null | undefined> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/domain${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      const body = await res.json() as {
        domain?: DomainState | null;
        ok?: boolean;
        error?: string;
        deploy?: { job_id?: string; error?: string };
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return state;
      }
      if (body.deploy) setDeployJob(body.deploy);
      if ('domain' in body) {
        setState(body.domain ?? null);
        return body.domain ?? null;
      }
      // DELETE returns { ok: true }
      setState(null);
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return state;
    } finally {
      setBusy(false);
    }
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    const next = await callApi('', {
      body: JSON.stringify({ hostname: input.trim(), prefer, auto_deploy: autoDeploy }),
    });
    if (next) setInput('');
  }

  // Loading state
  if (state === undefined) {
    return <div style={{ color: 'var(--color-text-light)', fontSize: '0.9rem' }}>Loading domain status…</div>;
  }

  // No domain configured — the "Add a custom domain" entry point.
  if (state === null) {
    return (
      <div className="stack">
        {fallbackUrl && (
          <p className="muted text-sm">
            You're developing on{' '}
            <a href={fallbackUrl} target="_blank" rel="noopener"><code>{fallbackUrl}</code></a>{' '}
            — an internal address that's kept out of Google. When you're ready to go
            public, enter your real domain below.
          </p>
        )}
        <div className="text-sm" style={{
          padding: '0.6rem 0.85rem', background: 'var(--color-surface)',
          border: '1px solid var(--color-border)', borderRadius: '0.5rem',
        }}>
          <strong>How going live works</strong>
          <ol style={{ margin: '0.35rem 0 0', paddingLeft: '1.25rem' }}>
            <li>Enter your domain here — we instantly republish your site with it as
              the canonical address (sitemap, links, social cards all use it).</li>
            <li><strong>Then</strong> point your domain's DNS at us (we'll show the exact
              record). Doing DNS last means your published site already has the right
              address baked in — visitors and Google never see the internal one.</li>
          </ol>
        </div>
        <form onSubmit={onAdd} className="stack">
          <div className="field">
            <label>Your domain</label>
            <input
              name="hostname"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="example.com or www.example.com"
              autoComplete="off"
              disabled={busy}
              required
            />
            <p className="muted text-sm">
              Type either the apex (<code>example.com</code>) or the www variant
              (<code>www.example.com</code>) — we'll register <strong>both</strong> with
              Cloudflare Pages so neither variant returns a 522 error. You don't need
              DNS in place yet; that's the last step.
            </p>
          </div>

          {inputPick && inputPick.alias && (
            <RegisterPreview pick={inputPick} prefer={prefer} setPrefer={setPrefer} />
          )}

          {inputPick && !inputPick.alias && (
            <p className="muted text-sm" style={{
              padding: '0.5rem 0.75rem',
              background: 'var(--color-surface)',
              borderRadius: '0.375rem',
              border: '1px solid var(--color-border)',
            }}>
              ℹ <code>{inputPick.canonical}</code> looks like a subdomain. We'll register it
              as-is — no apex/www pair. (Type the apex if you want the pair flow.)
            </p>
          )}

          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoDeploy}
              onChange={(e) => setAutoDeploy(e.target.checked)}
              style={{ marginTop: '0.25rem' }}
              disabled={busy}
            />
            <span className="text-sm">
              <strong>Publish now</strong> <span className="muted">(recommended)</span>
              <br />
              <span className="muted text-sm">
                Republish immediately so the new domain is baked into your live site as
                the canonical address. Uncheck only if you have unpublished drafts you
                don't want to ship yet — you can publish later from the deploy panel.
              </span>
            </span>
          </label>

          {error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>⚠ {error}</p>}
          <div>
            <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
              {busy ? (autoDeploy ? 'Setting up + publishing…' : 'Setting up…') : (autoDeploy ? 'Use this domain + publish' : 'Use this domain')}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // Domain configured. The domain is ALREADY the canonical URL of the
  // published site (domain-first model); `state.status` only tells us whether
  // the customer's DNS change has landed yet.
  const dnsOk = state.status === 'verified' || state.status === 'live';
  return (
    <div className="stack">
      <DomainBadge status={state.status} />

      <p className="text-sm">
        <strong>Domain:</strong> <code>{state.hostname}</code>
        {state.alias && (
          <>
            {' '}<span className="muted">+</span> <code>{state.alias.hostname}</code>{' '}
            <span className="muted text-sm">
              (301 → {state.hostname})
            </span>
          </>
        )}
      </p>

      <p className="muted text-sm">
        This is your site's canonical address — it's baked into your published
        sitemap, page links, and social cards.{' '}
        {dnsOk
          ? 'DNS is verified, so it\'s serving live.'
          : 'It goes live for visitors as soon as your DNS points at us (below).'}
      </p>

      {deployJob?.job_id && (
        <p className="muted text-sm">
          ↻ Republish queued (job <code>{deployJob.job_id}</code>) so the canonical
          URLs + sitemap reflect this domain.
        </p>
      )}
      {deployJob?.error && (
        <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
          ⚠ Republish failed to enqueue: {deployJob.error}. Trigger a deploy
          manually from the deploy panel to refresh canonical URLs.
        </p>
      )}

      {state.alias && (state.status !== state.alias.status || state.alias.status === 'failed') && (
        <p className="text-sm" style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: '0.375rem',
          padding: '0.5rem 0.75rem',
        }}>
          <strong>Sister hostname status:</strong> {state.alias.hostname} is{' '}
          <strong>{state.alias.status}</strong>.
          {state.alias.failure_reason && (
            <span style={{ color: 'var(--color-danger)' }}> {state.alias.failure_reason}</span>
          )}
          {state.alias.status === 'pending' && (
            <span className="muted"> Point a CNAME at <code>{state.dns_target}</code> for this
            hostname too — until it resolves, visitors who type it get a 522.</span>
          )}
        </p>
      )}

      {!dnsOk && state.status !== 'failed' && (
        <PendingInstructions state={state} fallbackUrl={fallbackUrl} />
      )}

      {dnsOk && (
        <p className="text-sm">
          ✓ Serving at{' '}
          <a href={`https://${state.hostname}`} target="_blank" rel="noopener">
            https://{state.hostname}
          </a>.
        </p>
      )}

      {state.status === 'failed' && (
        <FailedInstructions reason={state.failure_reason} />
      )}

      {error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>⚠ {error}</p>}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {!dnsOk && (
          <button
            className="btn"
            type="button"
            onClick={() => void callApi('/poll')}
            disabled={busy}
          >
            {busy ? 'Checking…' : 'Check DNS status'}
          </button>
        )}
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => {
            if (confirm(`Detach ${state.hostname}? Your live URL will revert to the fallback.`)) {
              void callApi('', { method: 'DELETE' });
            }
          }}
          disabled={busy}
        >
          Remove domain
        </button>
      </div>
    </div>
  );
}

function RegisterPreview({
  pick, prefer, setPrefer,
}: {
  pick: { canonical: string; alias: string | null; registrations: string[] };
  prefer: 'apex' | 'www';
  setPrefer: (v: 'apex' | 'www') => void;
}) {
  if (!pick.alias) return null;
  return (
    <div style={{
      padding: '0.75rem 1rem',
      background: 'var(--color-surface)',
      borderRadius: '0.5rem',
      border: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
    }}>
      <div className="text-sm">
        <strong>Both will be registered on Cloudflare Pages:</strong>
        <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
          <li><code>{pick.canonical}</code> <span className="muted">(canonical)</span></li>
          <li><code>{pick.alias}</code> <span className="muted">(301 redirects to canonical)</span></li>
        </ul>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="text-sm muted">Canonical:</span>
        <label style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center', cursor: 'pointer' }}>
          <input type="radio" name="prefer" checked={prefer === 'apex'} onChange={() => setPrefer('apex')} />
          <span className="text-sm">Apex <span className="muted">(recommended)</span></span>
        </label>
        <label style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center', cursor: 'pointer' }}>
          <input type="radio" name="prefer" checked={prefer === 'www'} onChange={() => setPrefer('www')} />
          <span className="text-sm">www</span>
        </label>
      </div>
    </div>
  );
}

function DomainBadge({ status }: { status: DomainState['status'] }) {
  const styles: Record<DomainState['status'], { bg: string; fg: string; label: string }> = {
    pending:  { bg: '#fffbeb', fg: '#7c2d12', label: '⏳ Point your DNS' },
    verified: { bg: '#dcfce7', fg: '#14532d', label: '● Live — DNS verified' },
    live:     { bg: '#dcfce7', fg: '#14532d', label: '● Live' },
    failed:   { bg: '#fee2e2', fg: '#7f1d1d', label: '⚠ DNS error' },
  };
  const s = styles[status];
  return (
    <span style={{
      background: s.bg, color: s.fg, padding: '0.25rem 0.6rem',
      borderRadius: '0.375rem', fontSize: '0.85rem', fontWeight: 500,
      display: 'inline-block', alignSelf: 'flex-start',
    }}>{s.label}</span>
  );
}

function PendingInstructions({ state, fallbackUrl }: { state: DomainState; fallbackUrl?: string }) {
  // Two DNS records when a pair is registered — one for canonical, one
  // for alias. Both must resolve at the same CNAME/A target before CF
  // verifies either of them.
  const hostnames = state.alias ? [state.hostname, state.alias.hostname] : [state.hostname];
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <p className="text-sm">
        <strong>Last step — point your DNS.</strong> Add{' '}
        {hostnames.length === 2 ? 'these DNS records' : 'this DNS record'} at your
        registrar to send your domain to Typeroll:
      </p>
      {state.dns_target ? (
        <>
          <pre style={{
            background: 'var(--color-surface)', padding: '0.75rem 1rem',
            borderRadius: '0.375rem', fontSize: '0.85rem', overflow: 'auto',
          }}>{hostnames.map((h) => `CNAME  ${asLabel(h)}  →  ${state.dns_target}`).join('\n')}</pre>
          <p className="muted text-sm">
            For the apex (no subdomain) you'll need <strong>A</strong>/<strong>AAAA</strong>{' '}
            records or a CNAME-flattening provider. Once DNS resolves for{' '}
            {hostnames.length === 2 ? 'both records' : 'this record'}, Cloudflare issues
            the SSL cert automatically — typically within 1–10 min. Click <strong>Check
            DNS status</strong> below to refresh.
          </p>
        </>
      ) : (
        // domain_dns_target is empty (attached before the CF project was
        // stamped). Don't render a broken "CNAME @ → " with no value — tell
        // the customer it's being finalised; a poll backfills it server-side.
        <p className="text-sm" style={{
          background: 'var(--color-surface)', border: '1px solid var(--color-border)',
          borderRadius: '0.375rem', padding: '0.6rem 0.85rem',
        }}>
          ⏳ We're finalising the exact DNS target for{' '}
          {hostnames.length === 2 ? 'these hostnames' : <code>{state.hostname}</code>}.
          Click <strong>Check DNS status</strong> below — the CNAME target will
          appear here.
        </p>
      )}
      {state.alias && (
        <p className="muted text-sm">
          <strong>Both records must resolve</strong> — otherwise one variant returns
          522 to visitors who type it. The status above tracks each separately.
        </p>
      )}
      {fallbackUrl && (
        <p className="muted text-sm">
          Your published site already uses <code>{state.hostname}</code> as its canonical
          address — it just isn't reachable there until DNS resolves. While you wait you
          can preview at{' '}
          <a href={fallbackUrl} target="_blank" rel="noopener"><code>{fallbackUrl}</code></a>{' '}
          (kept out of search engines).
        </p>
      )}
    </div>
  );
}

function FailedInstructions({ reason }: { reason: string | null }) {
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
        {reason ?? 'Cloudflare reported an error verifying this domain.'}
      </p>
      <p className="muted text-sm">
        Common fixes: double-check the CNAME target, remove conflicting A/AAAA
        records, or wait a few minutes for DNS propagation. Click <strong>Check
        status</strong> after correcting to retry.
      </p>
    </div>
  );
}

function asLabel(hostname: string): string {
  // For www.example.com the DNS record name is `www`. For apex (example.com)
  // it's `@`. Cosmetic — the customer will likely paste into their registrar's
  // dialog which has its own field labels, but showing the right token saves
  // a question.
  const parts = hostname.split('.');
  if (parts.length === 2) return '@';
  return parts.slice(0, parts.length - 2).join('.');
}
