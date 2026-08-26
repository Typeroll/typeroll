import { useEffect, useState } from 'react';

interface ExtensionSummary {
  id: string;
  name: string;
  distribution: 'private' | 'unlisted' | 'public';
  status: 'active' | 'suspended';
  client_id: string;
}

interface VersionSummary {
  version: string;
  status: string;
  manifest_sha256: string;
  published_at?: string;
}

export default function DeveloperExtensions() {
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [versions, setVersions] = useState<Record<string, VersionSummary[]>>({});
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState('');
  const [selected, setSelected] = useState('');

  async function load() {
    const response = await fetch('/api/developer/extensions');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Failed to load Extensions');
    setExtensions(data.extensions ?? []);
    const details = await Promise.all((data.extensions ?? []).map(async (extension: ExtensionSummary) => {
      const detail = await fetch(`/api/developer/extensions/${encodeURIComponent(extension.id)}`);
      const payload = await detail.json();
      return [extension.id, payload.versions ?? []] as const;
    }));
    setVersions(Object.fromEntries(details));
  }

  useEffect(() => { load().catch((err) => setError(err.message)); }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setSecret(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/developer/extensions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: form.get('id'), name: form.get('name'), distribution: form.get('distribution'),
        trusted_origins: String(form.get('trusted_origins') ?? '').split(/\s+/).filter(Boolean),
      }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setError(data.error ?? 'Failed to create Extension');
    setSecret(data.client_secret); event.currentTarget.reset(); await load();
  }

  async function saveVersion(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return; setBusy(true); setError('');
    let parsed: unknown;
    try { parsed = JSON.parse(manifest); } catch { setBusy(false); return setError('Manifest must be valid JSON.'); }
    const response = await fetch(`/api/developer/extensions/${encodeURIComponent(selected)}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: parsed }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setError(data.error ?? 'Manifest validation failed');
    await load();
  }

  async function publish(extensionId: string, version: string) {
    if (!confirm(`Publish immutable version ${version}? Its asset hashes and manifest cannot be changed afterwards.`)) return;
    setBusy(true); setError('');
    const response = await fetch(`/api/developer/extensions/${encodeURIComponent(extensionId)}/versions/${encodeURIComponent(version)}/publish`, { method: 'POST' });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setError(data.error ?? 'Publish failed');
    await load();
  }

  async function lifecycle(extensionId: string, version: string, status: 'deprecated' | 'revoked') {
    const reason = status === 'revoked' ? prompt('Revocation reason (required):') : undefined;
    if (status === 'revoked' && !reason) return;
    if (!confirm(`${status === 'revoked' ? 'Revoke' : 'Deprecate'} ${version}?`)) return;
    setBusy(true); setError('');
    const response = await fetch(`/api/developer/extensions/${encodeURIComponent(extensionId)}/versions/${encodeURIComponent(version)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, reason }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setError(data.error ?? 'Version update failed');
    await load();
  }

  async function rotateClientSecret(extensionId: string) {
    if (!confirm('Rotate the Extension client secret? Existing launch-code exchanges will stop using the previous secret immediately.')) return;
    setBusy(true); setError(''); setSecret(null);
    const response = await fetch(`/api/developer/extensions/${encodeURIComponent(extensionId)}/credentials/rotate`, { method: 'POST' });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setError(data.error ?? 'Client secret rotation failed');
    setSecret(data.client_secret);
  }

  async function changeDistribution(event: React.FormEvent<HTMLFormElement>, extension: ExtensionSummary) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const distribution = String(form.get('distribution')) as ExtensionSummary['distribution'];
    if (distribution === extension.distribution) return;
    if (!confirm(`Change distribution from ${extension.distribution} to ${distribution}? This is only allowed while every version is a draft.`)) return;
    setBusy(true); setError('');
    const response = await fetch(`/api/developer/extensions/${encodeURIComponent(extension.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ distribution }),
    });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setError(data.error ?? 'Distribution update failed');
    await load();
  }

  return <div style={{ display: 'grid', gap: '1rem' }}>
    {error && <div className="notice notice--error">{error}</div>}
    {secret && <div className="notice notice--warning">
      <strong>Copy the client secret now.</strong> It will not be shown again.
      <code style={{ display: 'block', marginTop: '.5rem', overflowWrap: 'anywhere' }}>{secret}</code>
    </div>}

    <section className="card">
      <h2>Create Extension</h2>
      <form onSubmit={create} style={{ display: 'grid', gap: '.75rem', maxWidth: 720 }}>
        <label>Namespaced id<input name="id" required placeholder="se.vendor.quote-generator" /></label>
        <label>Name<input name="name" required placeholder="Quote Generator" /></label>
        <label>Distribution<select name="distribution" defaultValue="private"><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></label>
        <label>Trusted origins <span className="muted">(space separated)</span><input name="trusted_origins" placeholder="https://admin.vendor.example https://api.vendor.example" /></label>
        <button className="btn" disabled={busy}>Create Extension</button>
      </form>
    </section>

    <section className="card">
      <h2>Manifest version</h2>
      <form onSubmit={saveVersion} style={{ display: 'grid', gap: '.75rem' }}>
        <label>Extension<select value={selected} onChange={(event) => setSelected(event.target.value)} required><option value="">Choose…</option>{extensions.map((extension) => <option key={extension.id} value={extension.id}>{extension.name}</option>)}</select></label>
        <label>typeroll-extension.json<textarea rows={18} value={manifest} onChange={(event) => setManifest(event.target.value)} spellCheck={false} placeholder="Paste a complete manifest…" /></label>
        <button className="btn" disabled={busy || !selected}>Validate and save draft</button>
      </form>
    </section>

    <section>
      <h2>Your Extensions</h2>
      <div style={{ display: 'grid', gap: '.75rem' }}>
        {extensions.map((extension) => <article className="card" key={extension.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'start' }}>
            <div><h3>{extension.name}</h3><code>{extension.id}</code><p className="muted text-sm">Client id: {extension.client_id}</p></div>
            <span className="status">{extension.distribution} · {extension.status}</span>
          </div>
          <div style={{ marginTop: '1rem', display: 'grid', gap: '.5rem' }}>
            {(versions[extension.id] ?? []).map((version) => <div key={version.version} style={{ display: 'flex', gap: '.75rem', alignItems: 'center' }}>
              <strong>{version.version}</strong><span className="muted">{version.status}</span><code>{version.manifest_sha256.slice(0, 12)}</code>
              {version.status === 'draft' && <button className="btn btn--secondary" disabled={busy} onClick={() => publish(extension.id, version.version)}>Publish</button>}
              {version.status === 'published' && <button className="btn btn--secondary" disabled={busy} onClick={() => lifecycle(extension.id, version.version, 'deprecated')}>Deprecate</button>}
              {(version.status === 'published' || version.status === 'deprecated') && <button className="btn btn--danger" disabled={busy} onClick={() => lifecycle(extension.id, version.version, 'revoked')}>Revoke</button>}
            </div>)}
          </div>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '.75rem', alignItems: 'end', flexWrap: 'wrap' }}>
            <form onSubmit={(event) => changeDistribution(event, extension)} style={{ display: 'flex', gap: '.5rem', alignItems: 'end' }}>
              <label>Distribution<select name="distribution" defaultValue={extension.distribution} key={extension.distribution}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></label>
              <button className="btn btn--secondary" disabled={busy}>Update distribution</button>
            </form>
            <button className="btn btn--secondary" disabled={busy} onClick={() => rotateClientSecret(extension.id)}>Rotate client secret</button>
          </div>
        </article>)}
        {!extensions.length && <p className="muted">No Extensions registered yet.</p>}
      </div>
    </section>
  </div>;
}
