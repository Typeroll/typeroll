// Two-way switcher between HTML and Blocks mode for a single page.
//
// Switching is destructive in one direction (blocks → HTML loses the
// block tree because we don't have a block-to-HTML serializer; the
// rendered output stays on the live site until the next deploy but the
// editor draft is gone). Switching HTML → blocks runs the heuristic
// converter and flips content_mode.
//
// Lives in its own component so both editors can mount it without
// duplicating the API call + confirmation logic.

import { useState } from 'react';
import { ArrowLeftRight, AlertTriangle } from 'lucide-react';

interface Props {
  siteId: string;
  pageId: string;
  currentMode: 'html' | 'blocks';
}

export default function ContentModeSwitcher({ siteId, pageId, currentMode }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchToBlocks() {
    if (!confirm('Convert the HTML content to blocks? The conversion is heuristic — check the result afterwards. The original HTML is saved as a revision first.')) return;
    setBusy(true);
    setError(null);
    try {
      // Call the converter via the public route (cookie-authed equivalent
      // doesn't exist yet — but the cookie session also authorizes the
      // bearer-less path via requireSiteAccess on /api/sites/... mirrors
      // we shipped in Phase 2). Falling back to a two-step here:
      //   1. POST /blocks/convert via session
      // For now we use the v1 route with the user's API key won't work
      // from the browser — instead patch content_mode directly and let
      // the user run convert from MCP if they want the auto-conversion.
      const res = await fetch(`/api/sites/${siteId}/pages/${pageId}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'blocks', convert: true }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Switch failed (${res.status})`);
      }
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function switchToHtml() {
    if (!confirm('Switch to HTML mode? The page\'s current block tree WILL BE REMOVED (saved as a revision first, so you can restore it). The HTML content starts empty.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/pages/${pageId}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'html' }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Switch failed (${res.status})`);
      }
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={shell}>
      <div style={header}>
        <ArrowLeftRight size={14} />
        <strong style={{ fontSize: '.85rem' }}>Content mode</strong>
      </div>
      <p style={muted}>
        This page uses <strong>{currentMode === 'blocks' ? 'Blocks' : 'HTML'}</strong> mode.
        {currentMode === 'blocks'
          ? ' Block mode is the default — you edit in a structured tree view.'
          : ' HTML mode lets you write raw markup. Switch to blocks for a structured editor.'}
      </p>
      {currentMode === 'html' ? (
        <button type="button" onClick={switchToBlocks} disabled={busy} style={primaryBtn}>
          {busy ? 'Konverterar…' : 'Konvertera till Blocks'}
        </button>
      ) : (
        <div>
          <div style={warningBox}>
            <AlertTriangle size={14} />
            <span style={{ fontSize: '.8rem' }}>
              Switching to HTML discards the block tree (a revision is saved).
            </span>
          </div>
          <button type="button" onClick={switchToHtml} disabled={busy} style={dangerBtn}>
            {busy ? 'Switching…' : 'Switch to HTML mode'}
          </button>
        </div>
      )}
      {error && <p style={errorMsg}>{error}</p>}
    </div>
  );
}

const shell: React.CSSProperties = {
  padding: '0.75rem',
  border: '1px solid var(--color-border, #2a2a30)',
  borderRadius: 8,
  marginTop: '0.5rem',
};
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
};
const muted: React.CSSProperties = {
  fontSize: '.85rem', color: 'var(--color-text-muted, #a1a1aa)', margin: '0 0 .75rem',
};
const primaryBtn: React.CSSProperties = {
  padding: '.4rem .75rem', background: '#6366f1', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const dangerBtn: React.CSSProperties = {
  padding: '.4rem .75rem', background: 'transparent', color: '#ef4444',
  border: '1px solid #ef4444', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const warningBox: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '.4rem .6rem', marginBottom: 8,
  background: '#3b2410', color: '#fbbf24',
  border: '1px solid #92400e', borderRadius: 6,
};
const errorMsg: React.CSSProperties = {
  marginTop: 8, color: '#ef4444', fontSize: '.85rem',
};
