import { useEffect, useState, type FormEvent } from 'react';

type Connection = {
  status: 'connected' | 'disconnected'; revision: string; credentials_saved: boolean;
  github: { owner: string } | null;
  cloudflare: { account_id: string; account_name: string; bucket: string } | null;
};
type Connections = { github: Connection; cloudflare: Connection; github_setup: { available: boolean; install_url: string | null }; encryption_available: boolean };
const API = '/api/orgs/publishing';

async function request(path = '', method = 'GET', body?: unknown) {
  const response = await fetch(`${API}${path}`, { method, cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update the publishing connection');
  return data;
}

export default function PublishingConnections() {
  const [data, setData] = useState<Connections | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = async () => setData(await request());
  useEffect(() => {
    void refresh().catch((error: Error) => setError(error.message));
    const result = new URLSearchParams(window.location.search).get('github');
    if (result === 'connected') setNotice('GitHub connected. This organization can be reused for your sites.');
    if (result === 'failed') setError('GitHub was not connected. Install the publisher App with all-repository access and the requested permissions, then connect as an organization owner. If the request expired, start again.');
    if (result) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(provider: 'github' | 'cloudflare', event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(`/${provider}`, 'POST', { ...values, revision: data?.[provider].revision });
      if (provider === 'github') { window.location.assign(result.authorization_url); return; }
      form.reset();
      await refresh();
      setNotice('Cloudflare and R2 connected. Credentials are encrypted and can be reused for your sites.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Connection failed'); }
    finally { setBusy(false); }
  }

  async function disconnect(provider: 'github' | 'cloudflare') {
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/${provider}`, 'DELETE', { revision: data?.[provider].revision });
      await refresh();
      setNotice('Disconnected. Existing repositories, deployments, and media remain in your account.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not disconnect'); }
    finally { setBusy(false); }
  }

  return <div className="stack" style={{ maxWidth: 760 }} aria-busy={busy}>
    <p>Connect your agency’s accounts once and reuse them for multiple sites. Each site will have its own private GitHub repository and static Cloudflare Pages project.</p>
    <p className="muted">Account connections are available here. Creating site repositories and publishing from the editor are still being implemented.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <p>Loading connections…</p> : <>
      <section className="card stack" aria-labelledby="github-title">
        <h2 id="github-title">GitHub organization</h2>
        <p>Status: <strong>{data.github.status}</strong>{data.github.github && <> · {data.github.github.owner}</>}</p>
        {!data.github_setup.available ? <p>The publisher needs to configure its GitHub App before you can connect.</p> : <>
          <p>As a GitHub organization owner, <a href={data.github_setup.install_url!} target="_blank" rel="noreferrer">install the publisher GitHub App</a> with <strong>All repositories</strong>, then verify your account below. This includes repositories created for future sites.</p>
          <form className="stack" onSubmit={(event) => void submit('github', event)}>
            <div className="field"><label htmlFor="github-owner">GitHub organization name</label>
              <input id="github-owner" name="owner" required maxLength={39} defaultValue={data.github.github?.owner ?? ''} readOnly={Boolean(data.github.github)} placeholder="your-agency-sites" /></div>
            <button className="btn" disabled={busy} type="submit">{data.github.github ? 'Verify GitHub connection' : 'Connect GitHub'}</button>
          </form>
        </>}
        {data.github.status === 'connected' && <button className="btn btn--secondary" disabled={busy} onClick={() => void disconnect('github')}>Disconnect GitHub</button>}
      </section>
      <section className="card stack" aria-labelledby="cloudflare-title">
        <h2 id="cloudflare-title">Cloudflare and R2 media</h2>
        <p>Status: <strong>{data.cloudflare.status}</strong>{data.cloudflare.cloudflare && <> · {data.cloudflare.cloudflare.account_name} · {data.cloudflare.cloudflare.bucket}</>}</p>
        {data.cloudflare.credentials_saved && <p>API and R2 credentials are saved and hidden. To rotate them, enter the new credentials below.</p>}
        <p>Use a Cloudflare token scoped to your account with Pages Edit and Account Settings Read. Create an R2 bucket and Object Read &amp; Write credentials restricted to that bucket.</p>
        <p className="muted">Connect Cloudflare’s own GitHub App to the same organization with All repositories so Cloudflare can build your sites. The account check below verifies account access and Pages visibility, and uploads, reads, and deletes a small temporary R2 object. Project creation and public media delivery are verified separately.</p>
        {!data.encryption_available ? <p>The publisher needs to configure encrypted credential storage before you can connect.</p> :
          <form className="stack" onSubmit={(event) => void submit('cloudflare', event)} autoComplete="off">
            <div className="field"><label htmlFor="cf-account">Cloudflare Account ID</label><input id="cf-account" name="account_id" required pattern="[a-f0-9]{32}" maxLength={32} defaultValue={data.cloudflare.cloudflare?.account_id ?? ''} readOnly={Boolean(data.cloudflare.cloudflare)} /></div>
            <div className="field"><label htmlFor="r2-bucket">R2 bucket name</label><input id="r2-bucket" name="bucket" required maxLength={63} defaultValue={data.cloudflare.cloudflare?.bucket ?? ''} readOnly={Boolean(data.cloudflare.cloudflare)} /></div>
            <div className="field"><label htmlFor="cf-token">Cloudflare API token</label><input id="cf-token" name="api_token" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <div className="field"><label htmlFor="r2-access">R2 Access Key ID</label><input id="r2-access" name="access_key_id" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <div className="field"><label htmlFor="r2-secret">R2 Secret Access Key</label><input id="r2-secret" name="secret_access_key" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <button className="btn" disabled={busy} type="submit">{busy ? 'Checking connection…' : 'Verify and save Cloudflare'}</button>
          </form>}
        {data.cloudflare.status === 'connected' && <button className="btn btn--secondary" disabled={busy} onClick={() => void disconnect('cloudflare')}>Disconnect Cloudflare</button>}
        <p className="muted">This first connection supports standard R2 buckets on the account’s global S3 endpoint. Disconnecting removes saved Cloudflare credentials. It does not delete your resources.</p>
      </section>
    </>}
  </div>;
}
