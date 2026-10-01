import { useState } from 'react';
import type { RenderVersionInfo } from '@typeroll/shared';

interface Props {
  siteId: string;
  version: number;
  latest: number;
  /** Every known version, oldest first. */
  versions: RenderVersionInfo[];
  canChange: boolean;
}

/**
 * Shows the site's platform render version and lets an admin preview and
 * apply an upgrade. Nothing changes until "Upgrade" is pressed; the preview
 * opens the site rendered with the target version.
 */
export default function RenderVersionSettings({ siteId, version, latest, versions, canChange }: Props) {
  const [current, setCurrent] = useState(version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upgrades = versions.filter(info => info.version > current);
  const target = upgrades.length ? latest : null;

  async function preview(renderVersion: number) {
    setError('');
    const response = await fetch(`/api/sites/${siteId}/preview-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ render_version: renderVersion }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.url) { setError(body.error ?? 'Could not create a preview link.'); return; }
    window.open(body.url, '_blank', 'noopener');
  }

  async function apply(renderVersion: number) {
    setBusy(true);
    setError('');
    const response = await fetch(`/api/sites/${siteId}/render-version`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ render_version: renderVersion }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setError(body.error ?? 'Could not change the render version.'); return; }
    setCurrent(renderVersion);
  }

  return (
    <div className="card stack">
      <h2 style={{ fontSize: '1.125rem', margin: 0 }}>Rendering</h2>
      <p className="muted text-sm" style={{ margin: 0 }}>
        Platform updates never change how this site looks on their own. New rendering arrives as a
        version you can preview and then choose to upgrade to. The live site changes at the next deploy.
      </p>
      <p style={{ margin: 0 }}>
        This site renders with <strong>version {current}</strong>
        {current === latest ? ' (latest).' : ` · version ${latest} is available.`}
      </p>
      {upgrades.length > 0 && (
        <div className="stack" style={{ gap: '.5rem' }}>
          {upgrades.map(info => (
            <div key={info.version}>
              <strong>Version {info.version}: {info.title}</strong>
              <ul style={{ margin: '.25rem 0 0 1.25rem' }}>
                {info.changes.map(change => <li key={change}>{change}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" style={{ margin: 0, color: 'var(--color-danger)' }}>{error}</p>}
      <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap' }}>
        {target !== null && (
          <button type="button" className="btn btn--secondary" onClick={() => preview(target)}>
            Preview with version {target}
          </button>
        )}
        {target !== null && canChange && (
          <button type="button" className="btn" disabled={busy} onClick={() => apply(target)}>
            Upgrade to version {target}
          </button>
        )}
        {current > 1 && canChange && (
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => apply(current - 1)}>
            Return to version {current - 1}
          </button>
        )}
      </div>
    </div>
  );
}
