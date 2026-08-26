import { useEffect, useState } from 'react';
import {
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  PackagePlus,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from 'lucide-react';

interface Installation {
  id: string;
  extension_id: string;
  developer_org_id: string;
  version: string;
  previous_version?: string;
  status: string;
  granted_scopes: string[];
  version_status?: string;
  components?: Array<{ id: string; label: string; block_type_id: string }>;
  issuer_trust?: { status: 'pending' | 'trusted' | 'revoked'; paired_at?: string } | null;
  manifest?: {
    name: string;
    developer: { name: string };
    permissions: Array<{ scope: string; reason: string }>;
    auth?: { pairing_url?: string };
    data_handling?: { personal_data: boolean; data_location?: string };
  };
}

interface CatalogEntry {
  extension_id: string;
  developer_org_id: string;
  version: string;
  name: string;
  developer_name: string;
  description?: string;
  permissions: Array<{ scope: string; reason: string }>;
  data_handling?: { personal_data: boolean; data_location?: string };
}

interface Feedback {
  kind: 'success' | 'error';
  message: string;
}

function extensionName(item: Installation): string {
  return item.manifest?.name ?? item.extension_id;
}

function formatPairedAt(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export default function ExtensionSettings({ siteId }: { siteId: string }) {
  const [items, setItems] = useState<Installation[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogEntry | null>(null);
  const [copied, setCopied] = useState('');

  async function load() {
    const response = await fetch(`/api/sites/${siteId}/extensions`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Failed to load extensions');
    setItems(data.extensions ?? []);
  }

  useEffect(() => {
    load().catch((error) => setFeedback({ kind: 'error', message: error.message }));
  }, [siteId]);

  useEffect(() => {
    fetch('/api/extensions/catalog').then(async (response) => {
      const data = await response.json();
      if (response.ok) setCatalog(data.extensions ?? []);
    }).catch(() => undefined);
  }, []);

  function beginAction() {
    setBusy(true);
    setFeedback(null);
  }

  async function install(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginAction();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(String(form.get('config') || '{}'));
    } catch {
      setBusy(false);
      setFeedback({ kind: 'error', message: 'Configuration must be valid JSON.' });
      return;
    }
    const scopes = String(form.get('scopes') ?? '').split(/[\s,]+/).filter(Boolean);
    const response = await fetch(`/api/sites/${siteId}/extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        developer_org_id: form.get('developer_org_id'),
        extension_id: form.get('extension_id'),
        version: form.get('version'),
        granted_scopes: scopes,
        config,
      }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) {
      setFeedback({ kind: 'error', message: data.error ?? 'Installation failed' });
      return;
    }
    formElement.reset();
    setSelectedCatalog(null);
    setFeedback({ kind: 'success', message: 'Extension installed. You can now add its frontend blocks to your pages.' });
    await load();
  }

  async function setStatus(item: Installation, status: 'enabled' | 'disabled') {
    beginAction();
    const response = await fetch(`/api/sites/${siteId}/extensions/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setFeedback({ kind: 'error', message: data.error ?? 'Update failed' });
    setFeedback({ kind: 'success', message: `${extensionName(item)} ${status === 'enabled' ? 'enabled' : 'disabled'}.` });
    await load();
  }

  async function rotate(item: Installation) {
    if (!confirm('Rotate this installation credential? The previous credential gets a five-minute grace period.')) return;
    beginAction();
    setCredential(null);
    const response = await fetch(`/api/sites/${siteId}/extensions/${item.id}/rotate-credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grace_seconds: 300 }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setFeedback({ kind: 'error', message: data.error ?? 'Rotation failed' });
    setCredential(data.credential);
    setFeedback({ kind: 'success', message: `A new credential was created for ${extensionName(item)}.` });
  }

  async function pairIssuer(item: Installation) {
    beginAction();
    const response = await fetch(`/api/sites/${siteId}/extensions/${item.id}/pair`, { method: 'POST' });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setFeedback({ kind: 'error', message: data.error ?? 'Secure connection failed' });
    setFeedback({ kind: 'success', message: `${extensionName(item)} now trusts this Typeroll instance.` });
    await load();
  }

  async function uninstall(item: Installation) {
    if (!confirm(`Uninstall ${extensionName(item)}? Existing page blocks will remain as unavailable placeholders.`)) return;
    beginAction();
    const response = await fetch(`/api/sites/${siteId}/extensions/${item.id}`, { method: 'DELETE' });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setFeedback({ kind: 'error', message: data.error ?? 'Uninstall failed' });
    setFeedback({ kind: 'success', message: `${extensionName(item)} uninstalled.` });
    await load();
  }

  async function rollback(item: Installation) {
    if (!item.previous_version || !confirm(`Roll back from ${item.version} to ${item.previous_version}?`)) return;
    beginAction();
    const response = await fetch(`/api/sites/${siteId}/extensions/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: item.previous_version }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setFeedback({ kind: 'error', message: data.error ?? 'Rollback failed' });
    setFeedback({ kind: 'success', message: `${extensionName(item)} rolled back to ${item.previous_version}.` });
    await load();
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? '' : current), 1800);
    } catch {
      setFeedback({ kind: 'error', message: 'Could not copy automatically. Select and copy the value manually.' });
    }
  }

  return <div className="extensions">
    <div className="extensions__intro">
      <div className="extensions__intro-icon"><Blocks size={24} aria-hidden="true" /></div>
      <div>
        <h2>Connect services and custom applications</h2>
        <p>Extensions can add interactive blocks to your public site and secure tools to Typeroll admin. The application backend remains hosted and operated by its developer; premium Typeroll Apps are operated only by Typeroll.</p>
      </div>
    </div>

    <div aria-live="polite" aria-atomic="true">
      {feedback && <div className={`extensions__notice extensions__notice--${feedback.kind}`}>
        {feedback.kind === 'success' ? <CheckCircle2 size={19} aria-hidden="true" /> : <TriangleAlert size={19} aria-hidden="true" />}
        <span>{feedback.message}</span>
        <button type="button" aria-label="Dismiss message" onClick={() => setFeedback(null)}>×</button>
      </div>}
    </div>

    {credential && <div className="extensions__credential">
      <KeyRound size={21} aria-hidden="true" />
      <div>
        <strong>Copy the new credential now</strong>
        <p>It is shown only once. Store it in the extension provider's secret manager.</p>
        <div className="extensions__code-row">
          <code>{credential}</code>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => copy(credential, 'credential')}>
            {copied === 'credential' ? <Check size={15} /> : <Copy size={15} />}
            {copied === 'credential' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>}

    {catalog.length > 0 && <section className="extensions__section">
      <div className="extensions__section-heading">
        <div><span className="extensions__eyebrow">Reviewed for this Typeroll instance</span><h2>Extension catalog</h2></div>
      </div>
      <div className="extensions__catalog">
        {catalog.map((entry) => <article className="extensions__catalog-card" key={`${entry.developer_org_id}:${entry.extension_id}`}>
          <div className="extensions__app-icon">{entry.name.slice(0, 1).toUpperCase()}</div>
          <div className="extensions__catalog-copy">
            <h3>{entry.name}</h3>
            <p className="extensions__meta">By {entry.developer_name} · Version {entry.version}</p>
            {entry.description && <p>{entry.description}</p>}
          </div>
          <button type="button" className="btn btn--secondary" onClick={() => setSelectedCatalog(entry)}>Review and install</button>
        </article>)}
      </div>
    </section>}

    {selectedCatalog && <section className="extensions__install-card">
      <div className="extensions__install-heading">
        <div className="extensions__app-icon extensions__app-icon--large">{selectedCatalog.name.slice(0, 1).toUpperCase()}</div>
        <div><span className="extensions__eyebrow">Review installation</span><h2>Install {selectedCatalog.name}</h2><p>Check what the extension can access before adding it to this site.</p></div>
      </div>
      <InstallForm entry={selectedCatalog} busy={busy} onSubmit={install} onCancel={() => setSelectedCatalog(null)} />
    </section>}

    {!selectedCatalog && <details className="extensions__manual" open={catalog.length === 0 && items.length === 0}>
      <summary>
        <span className="extensions__summary-icon"><PackagePlus size={20} aria-hidden="true" /></span>
        <span><strong>Install a private or unlisted extension</strong><small>Use identifiers supplied by the extension developer.</small></span>
        <ChevronDown className="extensions__chevron" size={19} aria-hidden="true" />
      </summary>
      <div className="extensions__manual-body">
        <div className="extensions__manual-intro">
          <ShieldCheck size={20} aria-hidden="true" />
          <p>Private extensions must already be registered on this Typeroll instance or explicitly allowlisted for this site. Ask the developer for the three identifiers and the exact permissions below.</p>
        </div>
        <InstallForm busy={busy} onSubmit={install} />
      </div>
    </details>}

    <section className="extensions__section">
      <div className="extensions__section-heading">
        <div><span className="extensions__eyebrow">This site</span><h2>Installed extensions</h2></div>
        <span className="extensions__count">{items.length}</span>
      </div>
      <div className="extensions__installed">
        {items.map((item) => <InstalledExtension
          key={item.id}
          item={item}
          siteId={siteId}
          busy={busy}
          copied={copied}
          onCopy={copy}
          onPair={pairIssuer}
          onSetStatus={setStatus}
          onRotate={rotate}
          onRollback={rollback}
          onUninstall={uninstall}
        />)}
        {!items.length && <div className="extensions__empty">
          <Blocks size={28} aria-hidden="true" />
          <h3>No extensions installed yet</h3>
          <p>Choose one from the catalog or install a private extension above.</p>
        </div>}
      </div>
    </section>
    <style dangerouslySetInnerHTML={{ __html: styles }} />
  </div>;
}

function InstallForm({ entry, busy, onSubmit, onCancel }: {
  entry?: CatalogEntry;
  busy: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
}) {
  return <form key={entry?.extension_id ?? 'manual'} onSubmit={onSubmit} className="extensions__form">
    <div className="extensions__form-step">
      <span>1</span>
      <div><strong>Identify the extension</strong><small>These values must match a registered, immutable version.</small></div>
    </div>
    <div className="extensions__form-grid">
      <label className="field">
        <span>Developer organization</span>
        <input name="developer_org_id" required defaultValue={entry?.developer_org_id} readOnly={Boolean(entry)} placeholder="vendor-organization" autoComplete="off" />
        <small>The developer's Typeroll organization ID.</small>
      </label>
      <label className="field">
        <span>Extension ID</span>
        <input name="extension_id" required defaultValue={entry?.extension_id} readOnly={Boolean(entry)} placeholder="se.vendor.quote-generator" autoComplete="off" />
        <small>A namespaced ID supplied by the developer.</small>
      </label>
      <label className="field extensions__version-field">
        <span>Version</span>
        <input name="version" required defaultValue={entry?.version} readOnly={Boolean(entry)} placeholder="1.0.0" autoComplete="off" />
        <small>The exact version to install.</small>
      </label>
    </div>

    <div className="extensions__form-step">
      <span>2</span>
      <div><strong>Approve permissions</strong><small>Only grant scopes the extension needs for this site.</small></div>
    </div>
    {entry?.permissions.length ? <div className="extensions__permissions-review">
      {entry.permissions.map((permission) => <div key={permission.scope}>
        <ShieldCheck size={17} aria-hidden="true" />
        <div><code>{permission.scope}</code><p>{permission.reason}</p></div>
      </div>)}
      {entry.data_handling?.personal_data && <div className="extensions__data-note">
        <TriangleAlert size={17} aria-hidden="true" />
        <p>This provider declares external personal-data processing{entry.data_handling.data_location ? ` in ${entry.data_handling.data_location}` : ''}.</p>
      </div>}
    </div> : <label className="field">
      <span>Granted scopes</span>
      <input name="scopes" placeholder="content:read forms:write" autoComplete="off" />
      <small>Separate scopes with spaces or commas. Leave blank only when the extension requests none.</small>
    </label>}
    {entry && <input type="hidden" name="scopes" value={entry.permissions.map((permission) => permission.scope).join(' ')} />}

    <div className="extensions__form-step">
      <span>3</span>
      <div><strong>Configure</strong><small>Use the settings supplied by the developer. Secrets are encrypted at rest.</small></div>
    </div>
    <label className="field">
      <span>Configuration (JSON)</span>
      <textarea name="config" rows={6} defaultValue="{}" spellCheck={false} />
      <small>Keep <code>{'{}'}</code> when the extension needs no configuration.</small>
    </label>
    <div className="extensions__form-actions">
      <button className="btn" disabled={busy}>{busy ? 'Installing…' : 'Install extension'}</button>
      {onCancel && <button type="button" className="btn btn--secondary" onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}

function InstalledExtension({ item, siteId, busy, copied, onCopy, onPair, onSetStatus, onRotate, onRollback, onUninstall }: {
  item: Installation;
  siteId: string;
  busy: boolean;
  copied: string;
  onCopy: (value: string, key: string) => void;
  onPair: (item: Installation) => void;
  onSetStatus: (item: Installation, status: 'enabled' | 'disabled') => void;
  onRotate: (item: Installation) => void;
  onRollback: (item: Installation) => void;
  onUninstall: (item: Installation) => void;
}) {
  const paired = item.issuer_trust?.status === 'trusted';
  const pairedAt = formatPairedAt(item.issuer_trust?.paired_at);
  const active = item.status === 'enabled' && item.version_status !== 'revoked';

  return <article className="extensions__installed-card">
    <header className="extensions__installed-header">
      <div className="extensions__app-title">
        <div className="extensions__app-icon extensions__app-icon--large">{extensionName(item).slice(0, 1).toUpperCase()}</div>
        <div>
          <h3>{extensionName(item)}</h3>
          <p>{item.manifest?.developer.name || 'Unknown developer'} · Version {item.version}</p>
        </div>
      </div>
      <span className={`extensions__status extensions__status--${active ? 'active' : item.version_status === 'revoked' ? 'danger' : 'inactive'}`}>
        <span />{active ? 'Active' : item.version_status === 'revoked' ? 'Revoked' : 'Disabled'}
      </span>
    </header>

    {item.version_status === 'deprecated' && <div className="extensions__inline-warning"><TriangleAlert size={18} />This version is deprecated. Review and approve an upgrade.</div>}
    {item.version_status === 'revoked' && <div className="extensions__inline-error"><TriangleAlert size={18} />This version has been revoked. New Extension tokens, frontend deploys, and admin launch are blocked.</div>}

    <div className="extensions__setup">
      <div className="extensions__setup-card">
        <span className="extensions__setup-number">1</span>
        <div className="extensions__setup-icon"><Blocks size={20} /></div>
        <div><strong>Add it to a page</strong><p>Use the visual editor, or paste the component tag in HTML mode.</p></div>
      </div>
      <div className={`extensions__setup-card ${paired || !item.manifest?.auth?.pairing_url ? 'extensions__setup-card--done' : ''}`}>
        <span className="extensions__setup-number">2</span>
        <div className="extensions__setup-icon"><Link2 size={20} /></div>
        <div><strong>{paired ? 'Secure connection ready' : item.manifest?.auth?.pairing_url ? 'Connect the provider' : 'No pairing required'}</strong><p>{paired ? `This Typeroll instance is trusted${pairedAt ? ` since ${pairedAt}` : ''}.` : item.manifest?.auth?.pairing_url ? 'Allow the provider to verify signed requests from this Typeroll instance.' : 'This extension does not require issuer pairing.'}</p></div>
      </div>
    </div>

    {item.components?.length ? <section className="extensions__components">
      <div className="extensions__subheading"><Code2 size={18} /><div><h4>Use on your site</h4><p>Each component is available in both editing modes.</p></div></div>
      <div className="extensions__component-list">
        {item.components.map((component) => {
          const snippet = `<x-extension block="${component.block_type_id}" />`;
          const copyKey = `${item.id}:${component.id}`;
          return <div className="extensions__component" key={component.id}>
            <div className="extensions__component-name"><strong>{component.label}</strong><code>{component.block_type_id}</code></div>
            <div className="extensions__use-options">
              <div><span className="extensions__option-label"><Blocks size={15} /> Visual editor</span><p>Open a page, choose <strong>Add block</strong>, then select <strong>{component.label}</strong>.</p><a href={`/app/sites/${siteId}`}>Open pages <ExternalLink size={13} /></a></div>
              <div><span className="extensions__option-label"><Code2 size={15} /> HTML mode</span><p>Paste this component tag where the application should appear.</p><div className="extensions__code-row"><code>{snippet}</code><button type="button" className="btn btn--secondary btn--sm" onClick={() => onCopy(snippet, copyKey)}>{copied === copyKey ? <Check size={14} /> : <Copy size={14} />}{copied === copyKey ? 'Copied' : 'Copy'}</button></div></div>
            </div>
          </div>;
        })}
      </div>
    </section> : <div className="extensions__no-components"><Settings2 size={18} /><p>This extension adds admin functionality but no frontend blocks.</p></div>}

    {item.manifest?.auth?.pairing_url && !paired && <div className="extensions__pairing">
      <div><ShieldCheck size={21} /><div><strong>Complete the secure connection</strong><p>This one-time handshake sends this Typeroll instance's public signing identity to the extension provider. No customer data or private keys are shared.</p></div></div>
      <button type="button" className="btn" disabled={busy || item.status === 'revoked'} onClick={() => onPair(item)}>Trust this Typeroll instance</button>
    </div>}

    <details className="extensions__details">
      <summary><Wrench size={17} /> Permissions and management <ChevronDown size={17} /></summary>
      <div className="extensions__details-body">
        <section>
          <h4>Permissions</h4>
          {item.granted_scopes.length ? <ul className="extensions__scope-list">{item.granted_scopes.map((scope) => {
            const permission = item.manifest?.permissions.find((candidate) => candidate.scope === scope);
            return <li key={scope}><code>{scope}</code><span>{permission?.reason || 'No reason supplied.'}</span></li>;
          })}</ul> : <p className="extensions__muted">No Typeroll permissions granted.</p>}
        </section>
        {item.manifest?.data_handling?.personal_data && <div className="extensions__data-warning"><TriangleAlert size={18} /><p><strong>External personal-data processing</strong><br />The provider declares that personal data is processed outside Typeroll{item.manifest.data_handling.data_location ? ` in ${item.manifest.data_handling.data_location}` : ''}.</p></div>}
        <section>
          <h4>Technical details</h4>
          <dl className="extensions__technical">
            <div><dt>Installation ID</dt><dd><code>{item.id}</code></dd></div>
            <div><dt>Extension ID</dt><dd><code>{item.extension_id}</code></dd></div>
            <div><dt>Developer organization</dt><dd><code>{item.developer_org_id}</code></dd></div>
          </dl>
        </section>
        <div className="extensions__management-actions">
          {item.status === 'enabled' ? <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => onSetStatus(item, 'disabled')}>Disable extension</button> : item.status === 'disabled' ? <button type="button" className="btn" disabled={busy} onClick={() => onSetStatus(item, 'enabled')}>Enable extension</button> : null}
          <button type="button" className="btn btn--secondary" disabled={busy || item.status === 'revoked'} onClick={() => onRotate(item)}>Rotate credential</button>
          {item.previous_version && <button type="button" className="btn btn--secondary" disabled={busy || item.status === 'revoked'} onClick={() => onRollback(item)}>Roll back to {item.previous_version}</button>}
          <a className="btn btn--secondary" href={`/api/sites/${siteId}/extensions/${item.id}/diagnostics`} target="_blank" rel="noreferrer">Open diagnostics <ExternalLink size={14} /></a>
        </div>
        <div className="extensions__danger-zone">
          <div><strong>Uninstall extension</strong><p>Existing page blocks remain as unavailable placeholders.</p></div>
          <button type="button" className="btn btn--danger" disabled={busy || item.status === 'revoked'} onClick={() => onUninstall(item)}>Uninstall</button>
        </div>
      </div>
    </details>
  </article>;
}

const styles = `
  .extensions { display: grid; gap: 1.5rem; max-width: 1040px; }
  .extensions h2, .extensions h3, .extensions h4 { margin: 0; }
  .extensions p { margin: 0; }
  .extensions__intro { display: flex; align-items: flex-start; gap: 1rem; padding: 1.25rem 1.5rem; border: 1px solid #dbe3f0; border-radius: var(--radius-lg); background: linear-gradient(135deg, #f8fafc, #fff); }
  .extensions__intro-icon { display: grid; place-items: center; flex: 0 0 46px; height: 46px; color: #1d4ed8; background: #dbeafe; border-radius: .75rem; }
  .extensions__intro h2 { font-size: 1.15rem; margin-bottom: .3rem; }
  .extensions__intro p { max-width: 760px; color: var(--color-text-muted); }
  .extensions__notice, .extensions__credential { display: flex; align-items: flex-start; gap: .75rem; padding: .9rem 1rem; border-radius: var(--radius-md); border: 1px solid; }
  .extensions__notice--success { color: #166534; border-color: #bbf7d0; background: #f0fdf4; }
  .extensions__notice--error { color: #991b1b; border-color: #fecaca; background: #fef2f2; }
  .extensions__notice > button { margin-left: auto; border: 0; background: transparent; color: inherit; font-size: 1.3rem; line-height: 1; cursor: pointer; }
  .extensions__credential { color: #854d0e; border-color: #fde68a; background: #fffbeb; }
  .extensions__credential > div { flex: 1; min-width: 0; }
  .extensions__credential p { margin: .15rem 0 .65rem; color: #a16207; font-size: .875rem; }
  .extensions__section { display: grid; gap: .8rem; }
  .extensions__section-heading { display: flex; align-items: end; justify-content: space-between; gap: 1rem; }
  .extensions__section-heading h2 { font-size: 1.25rem; }
  .extensions__eyebrow { display: block; margin-bottom: .2rem; color: #64748b; font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .extensions__count { display: grid; place-items: center; min-width: 2rem; height: 2rem; padding: 0 .5rem; color: #475569; background: #e2e8f0; border-radius: 999px; font-size: .85rem; font-weight: 700; }
  .extensions__catalog { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: .75rem; }
  .extensions__catalog-card { display: grid; grid-template-columns: auto 1fr; gap: 1rem; padding: 1.25rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-sm); }
  .extensions__catalog-card .btn { grid-column: 1 / -1; justify-content: center; }
  .extensions__catalog-copy { display: grid; gap: .35rem; align-content: start; }
  .extensions__catalog-copy h3 { font-size: 1rem; }
  .extensions__catalog-copy > p:not(.extensions__meta) { color: #57534e; font-size: .9rem; }
  .extensions__meta { color: var(--color-text-muted); font-size: .8rem; }
  .extensions__app-icon { display: grid; place-items: center; width: 40px; height: 40px; color: #fff; background: linear-gradient(135deg, #0f172a, #334155); border-radius: .65rem; font-weight: 700; }
  .extensions__app-icon--large { width: 48px; height: 48px; border-radius: .8rem; font-size: 1.05rem; }
  .extensions__install-card, .extensions__manual { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-sm); overflow: hidden; }
  .extensions__install-card { padding: 1.5rem; }
  .extensions__install-heading { display: flex; gap: 1rem; align-items: flex-start; padding-bottom: 1.25rem; border-bottom: 1px solid var(--color-border); }
  .extensions__install-heading h2 { margin: .12rem 0 .3rem; font-size: 1.25rem; }
  .extensions__install-heading p { color: var(--color-text-muted); }
  .extensions__manual > summary { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .85rem; padding: 1.1rem 1.25rem; cursor: pointer; list-style: none; }
  .extensions__manual > summary::-webkit-details-marker, .extensions__details > summary::-webkit-details-marker { display: none; }
  .extensions__summary-icon { display: grid; place-items: center; width: 38px; height: 38px; color: #475569; background: #f1f5f9; border-radius: .6rem; }
  .extensions__manual summary span:nth-child(2) { display: grid; gap: .1rem; }
  .extensions__manual summary small { color: var(--color-text-muted); font-size: .82rem; font-weight: 400; }
  .extensions__chevron { color: #78716c; transition: transform .15s ease; }
  .extensions__manual[open] > summary .extensions__chevron, .extensions__details[open] > summary > svg:last-child { transform: rotate(180deg); }
  .extensions__manual-body { padding: 1.25rem 1.5rem 1.5rem; border-top: 1px solid var(--color-border); background: #fcfcfb; }
  .extensions__manual-intro { display: flex; gap: .7rem; align-items: flex-start; max-width: 780px; margin-bottom: 1.5rem; padding: .85rem 1rem; color: #334155; background: #f1f5f9; border-radius: var(--radius-md); font-size: .88rem; }
  .extensions__manual-intro svg { flex: 0 0 auto; color: #2563eb; }
  .extensions__form { display: grid; gap: 1rem; max-width: 820px; margin-top: 1.4rem; }
  .extensions__form-step { display: flex; align-items: center; gap: .7rem; margin-top: .35rem; }
  .extensions__form-step > span { display: grid; place-items: center; flex: 0 0 28px; height: 28px; color: #fff; background: #334155; border-radius: 999px; font-size: .8rem; font-weight: 700; }
  .extensions__form-step > div { display: grid; gap: .08rem; }
  .extensions__form-step small, .extensions__form .field > small { color: var(--color-text-muted); font-size: .78rem; font-weight: 400; }
  .extensions__form-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 8rem; gap: .75rem; }
  .extensions__form .field { gap: .35rem; }
  .extensions__form .field > span { font-size: .85rem; font-weight: 600; }
  .extensions__form .field input, .extensions__form .field textarea { width: 100%; padding: .65rem .75rem; border: 1px solid #d6d3d1; border-radius: var(--radius-md); background: #fff; outline: none; }
  .extensions__form .field input:focus, .extensions__form .field textarea:focus { border-color: #64748b; box-shadow: 0 0 0 3px #e2e8f0; }
  .extensions__form .field input[readonly] { color: #475569; background: #f8fafc; }
  .extensions__form textarea { font-family: var(--font-mono); font-size: .82rem; line-height: 1.55; resize: vertical; }
  .extensions__form-actions { display: flex; gap: .6rem; padding-top: .35rem; }
  .extensions__permissions-review { display: grid; gap: .55rem; }
  .extensions__permissions-review > div:not(.extensions__data-note) { display: flex; gap: .7rem; padding: .75rem .85rem; border: 1px solid #dbeafe; border-radius: var(--radius-md); background: #f8fbff; }
  .extensions__permissions-review svg { flex: 0 0 auto; color: #2563eb; margin-top: .1rem; }
  .extensions__permissions-review code { font-weight: 700; }
  .extensions__permissions-review p { color: #64748b; font-size: .82rem; margin-top: .12rem; }
  .extensions__data-note { display: flex; gap: .6rem; color: #854d0e; font-size: .85rem; }
  .extensions__data-note svg { color: #d97706; }
  .extensions__installed { display: grid; gap: 1rem; }
  .extensions__installed-card { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-sm); overflow: hidden; }
  .extensions__installed-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; padding: 1.35rem 1.5rem; }
  .extensions__app-title { display: flex; align-items: center; gap: .85rem; }
  .extensions__app-title h3 { font-size: 1.08rem; }
  .extensions__app-title p { margin-top: .22rem; color: var(--color-text-muted); font-size: .82rem; }
  .extensions__status { display: inline-flex; align-items: center; gap: .42rem; padding: .3rem .65rem; border-radius: 999px; font-size: .78rem; font-weight: 650; white-space: nowrap; }
  .extensions__status > span { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .extensions__status--active { color: #15803d; background: #dcfce7; }
  .extensions__status--inactive { color: #57534e; background: #f5f5f4; }
  .extensions__status--danger { color: #b91c1c; background: #fee2e2; }
  .extensions__inline-warning, .extensions__inline-error { display: flex; gap: .55rem; align-items: center; padding: .75rem 1.5rem; font-size: .85rem; border-top: 1px solid; border-bottom: 1px solid; }
  .extensions__inline-warning { color: #854d0e; border-color: #fde68a; background: #fffbeb; }
  .extensions__inline-error { color: #991b1b; border-color: #fecaca; background: #fef2f2; }
  .extensions__setup { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; padding: 0 1.5rem 1.25rem; }
  .extensions__setup-card { position: relative; display: grid; grid-template-columns: auto 1fr; gap: .7rem; min-height: 92px; padding: .9rem 1rem; border: 1px solid #e7e5e4; border-radius: var(--radius-md); background: #fafaf9; }
  .extensions__setup-card--done { border-color: #bbf7d0; background: #f0fdf4; }
  .extensions__setup-number { position: absolute; top: -.45rem; left: -.45rem; display: grid; place-items: center; width: 22px; height: 22px; color: #fff; background: #475569; border: 2px solid #fff; border-radius: 50%; font-size: .7rem; font-weight: 700; }
  .extensions__setup-card--done .extensions__setup-number { background: #16a34a; }
  .extensions__setup-icon { color: #475569; margin-top: .05rem; }
  .extensions__setup-card--done .extensions__setup-icon { color: #16a34a; }
  .extensions__setup-card strong { font-size: .88rem; }
  .extensions__setup-card p { margin-top: .15rem; color: #78716c; font-size: .8rem; line-height: 1.4; }
  .extensions__components { margin: 0 1.5rem 1.25rem; padding: 1.1rem; border: 1px solid #e2e8f0; border-radius: var(--radius-md); background: #f8fafc; }
  .extensions__subheading { display: flex; align-items: flex-start; gap: .6rem; margin-bottom: .8rem; }
  .extensions__subheading svg { color: #475569; margin-top: .05rem; }
  .extensions__subheading h4 { font-size: .9rem; }
  .extensions__subheading p { color: #64748b; font-size: .78rem; }
  .extensions__component-list { display: grid; gap: .75rem; }
  .extensions__component { padding: .9rem; border: 1px solid #e2e8f0; border-radius: var(--radius-md); background: #fff; }
  .extensions__component-name { display: flex; justify-content: space-between; gap: 1rem; padding-bottom: .7rem; border-bottom: 1px solid #f1f5f9; }
  .extensions__component-name code { color: #64748b; font-size: .72rem; overflow-wrap: anywhere; }
  .extensions__use-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; padding-top: .75rem; }
  .extensions__use-options > div + div { padding-left: 1rem; border-left: 1px solid #e2e8f0; }
  .extensions__option-label { display: flex; align-items: center; gap: .35rem; color: #334155; font-size: .78rem; font-weight: 700; }
  .extensions__use-options p { margin: .25rem 0 .55rem; color: #64748b; font-size: .78rem; }
  .extensions__use-options a { display: inline-flex; align-items: center; gap: .25rem; color: #1d4ed8; font-size: .78rem; font-weight: 600; }
  .extensions__code-row { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .extensions__code-row > code { flex: 1; min-width: 0; padding: .45rem .55rem; color: #334155; background: #f1f5f9; border-radius: .35rem; font-size: .72rem; overflow-wrap: anywhere; }
  .extensions__code-row .btn { flex: 0 0 auto; }
  .extensions__no-components { display: flex; gap: .55rem; margin: 0 1.5rem 1.25rem; padding: .85rem 1rem; color: #64748b; background: #f8fafc; border-radius: var(--radius-md); font-size: .85rem; }
  .extensions__pairing { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin: 0 1.5rem 1.25rem; padding: 1rem; border: 1px solid #bfdbfe; border-radius: var(--radius-md); background: #eff6ff; }
  .extensions__pairing > div { display: flex; gap: .7rem; align-items: flex-start; }
  .extensions__pairing svg { flex: 0 0 auto; color: #2563eb; }
  .extensions__pairing strong { color: #1e3a8a; font-size: .88rem; }
  .extensions__pairing p { max-width: 620px; margin-top: .18rem; color: #1e40af; font-size: .78rem; }
  .extensions__pairing .btn { flex: 0 0 auto; }
  .extensions__details { border-top: 1px solid var(--color-border); background: #fcfcfb; }
  .extensions__details > summary { display: flex; align-items: center; gap: .5rem; padding: .85rem 1.5rem; color: #57534e; cursor: pointer; list-style: none; font-size: .82rem; font-weight: 600; }
  .extensions__details > summary > svg:last-child { margin-left: auto; transition: transform .15s ease; }
  .extensions__details-body { display: grid; gap: 1.15rem; padding: .35rem 1.5rem 1.5rem; }
  .extensions__details-body h4 { margin-bottom: .55rem; font-size: .85rem; }
  .extensions__scope-list { display: grid; gap: .45rem; margin: 0; padding: 0; list-style: none; }
  .extensions__scope-list li { display: grid; grid-template-columns: minmax(130px, auto) 1fr; gap: .7rem; align-items: baseline; }
  .extensions__scope-list code { font-size: .76rem; font-weight: 700; }
  .extensions__scope-list span, .extensions__muted { color: #78716c; font-size: .8rem; }
  .extensions__data-warning { display: flex; gap: .6rem; padding: .8rem; color: #854d0e; border: 1px solid #fde68a; border-radius: var(--radius-md); background: #fffbeb; font-size: .82rem; }
  .extensions__technical { display: grid; gap: .35rem; }
  .extensions__technical > div { display: grid; grid-template-columns: 145px 1fr; gap: .75rem; }
  .extensions__technical dt { color: #78716c; font-size: .78rem; }
  .extensions__technical dd { margin: 0; min-width: 0; font-size: .78rem; overflow-wrap: anywhere; }
  .extensions__management-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  .extensions__danger-zone { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding-top: 1rem; border-top: 1px solid #fecaca; }
  .extensions__danger-zone strong { color: #991b1b; font-size: .85rem; }
  .extensions__danger-zone p { color: #78716c; font-size: .78rem; }
  .extensions__empty { display: grid; justify-items: center; gap: .4rem; padding: 2.5rem 1rem; color: #78716c; border: 1px dashed #d6d3d1; border-radius: var(--radius-lg); text-align: center; }
  .extensions__empty h3 { color: #44403c; font-size: 1rem; }
  .extensions__empty p { font-size: .85rem; }
  @media (max-width: 760px) {
    .extensions__form-grid, .extensions__setup, .extensions__use-options { grid-template-columns: 1fr; }
    .extensions__use-options > div + div { padding: .8rem 0 0; border-left: 0; border-top: 1px solid #e2e8f0; }
    .extensions__installed-header, .extensions__pairing, .extensions__danger-zone { align-items: stretch; flex-direction: column; }
    .extensions__installed-header { display: flex; }
    .extensions__status { align-self: flex-start; }
    .extensions__component-name { flex-direction: column; gap: .2rem; }
    .extensions__technical > div { grid-template-columns: 1fr; gap: .05rem; }
  }
  @media (max-width: 480px) {
    .extensions__intro { padding: 1rem; }
    .extensions__intro-icon { display: none; }
    .extensions__manual-body, .extensions__install-card, .extensions__installed-header, .extensions__details-body { padding-left: 1rem; padding-right: 1rem; }
    .extensions__setup { padding-left: 1rem; padding-right: 1rem; }
    .extensions__components, .extensions__pairing, .extensions__no-components { margin-left: 1rem; margin-right: 1rem; }
    .extensions__app-title { align-items: flex-start; }
    .extensions__code-row { align-items: stretch; flex-direction: column; }
    .extensions__code-row .btn { justify-content: center; }
  }
`;
