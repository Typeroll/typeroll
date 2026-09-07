import { useEffect, useState, type FormEvent } from 'react';

type Connection = {
  status: 'connected' | 'disconnected'; revision: string; credentials_saved: boolean;
  auth_method?: 'api_token' | 'oauth'; media_ready?: boolean;
  github: { owner: string } | null;
  cloudflare: { account_id: string; account_name: string; bucket: string } | null;
};
type Connections = { cloudflare_choices?: Array<{ id: string; name: string }>; cloudflare_setup?: { available: boolean }; github_choices: Array<{ owner: string; installation_id: string }>; github: Connection; cloudflare: Connection; github_setup: { available: boolean; install_url: string | null }; encryption_available: boolean };
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
    const parameters = new URLSearchParams(window.location.search);
    const result = parameters.get('github');
    if (result === 'connected') setNotice('GitHub connected. This organization can be reused for your sites.');
    if (result === 'select') setNotice('Choose the GitHub organization to connect below.');
    if (result === 'install_required') setError('Install the Typeroll GitHub App in your organization using the link below, then select Connect GitHub again.');
    if (result === 'permissions_required') setError('Open the App installation settings and approve the requested permissions with All repositories access, then connect again.');
    if (result === 'owner_required') setError('Sign in to GitHub as an owner of the organization you want to connect, then try again.');
    if (result === 'failed') setError('GitHub was not connected. Install the publisher App with all-repository access and the requested permissions, then connect as an organization owner. If the request expired, start again.');
    if (result) window.history.replaceState(null, '', window.location.pathname);
    const cloudflare = parameters.get('cloudflare');
    if (cloudflare === 'connected') setNotice('Cloudflare connected. Your account will be reused for this organization’s sites.');
    if (cloudflare === 'select') setNotice('Choose the Cloudflare account to connect below.');
    if (cloudflare === 'failed') setError('Cloudflare was not connected. Start again and approve the requested permissions for your account.');
    if (cloudflare) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(provider: 'github' | 'cloudflare', event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(`/${provider}`, 'POST', { ...values, revision: data?.[provider].revision });
      if (result.authorization_url) { window.location.assign(result.authorization_url); return; }
      form.reset();
      await refresh();
      setNotice(provider === 'github' ? 'GitHub connected. This organization can be reused for your sites.' : values.action === 'prepare_media' ? 'Media bucket prepared. Add its R2 access keys below to enable direct uploads.' : 'Cloudflare connection updated. Access is encrypted and reused for your sites.');
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
          <p>Sign in to GitHub and approve access. Typeroll finds the organizations you own; if there is more than one, you can choose after signing in. You do not need to enter an organization name or ID.</p>
          {(data.github_choices ?? []).length > 0 && <form className="stack" onSubmit={(event) => void submit('github', event)}>
            <div className="field"><label htmlFor="github-organization">Choose a GitHub organization</label>
              <select id="github-organization" name="installation_id" required defaultValue="">
                <option value="" disabled>Select an organization</option>
                {data.github_choices.map(choice => <option key={choice.installation_id} value={choice.installation_id}>{choice.owner} — github.com/{choice.owner}</option>)}
              </select></div>
            <button className="btn" disabled={busy} type="submit">Connect selected organization</button>
          </form>}
          <form className="stack" onSubmit={(event) => void submit('github', event)}>
            <button className="btn" disabled={busy} type="submit">{data.github.github ? 'Verify GitHub connection' : 'Connect GitHub'}</button>
          </form>
          <details><summary>First connection: install the Typeroll GitHub App</summary>
            <ol>
              <li><a href={data.github_setup.install_url!} target="_blank" rel="noreferrer">Open the App installation in GitHub</a> and select your organization.</li>
              <li>Select <strong>All repositories</strong> and approve the requested permissions. This also includes repositories Typeroll creates for future sites.</li>
              <li>Return here and select <strong>Connect GitHub</strong>. If you already installed the App, start with that button.</li>
            </ol>
          </details>
        </>}
        {data.github.status === 'connected' && <button className="btn btn--secondary" disabled={busy} onClick={() => void disconnect('github')}>Disconnect GitHub</button>}
      </section>
      <section className="card stack" aria-labelledby="cloudflare-title">
        <h2 id="cloudflare-title">Cloudflare and R2 media</h2>
        <p>Status: <strong>{data.cloudflare.status}</strong>{data.cloudflare.cloudflare && <> · {data.cloudflare.cloudflare.account_name} · {data.cloudflare.cloudflare.bucket}</>}</p>
        <p>Sign in to Cloudflare, choose your account, and approve access. You do not need to enter an Account ID or create a Cloudflare API token for this connection.</p>
        {data.cloudflare_setup?.available ? <>
          {(data.cloudflare_choices ?? []).length > 0 && <form className="stack" onSubmit={event => void submit('cloudflare', event)}>
            <input type="hidden" name="action" value="select" />
            <div className="field"><label htmlFor="cf-choice">Choose a Cloudflare account</label>
              <select id="cf-choice" name="account_id" required defaultValue=""><option value="" disabled>Select an account</option>
                {data.cloudflare_choices!.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select></div><button type="submit" className="btn" disabled={busy}>Connect selected account</button>
          </form>}
          <form onSubmit={event => void submit('cloudflare', event)}><input type="hidden" name="action" value="start" />
            <button type="submit" className="btn" disabled={busy}>{data.cloudflare.status === 'connected' ? 'Reconnect Cloudflare' : 'Connect Cloudflare'}</button>
          </form>
        </> : <p className="muted">Cloudflare sign-in is not available until the publisher finishes configuring its Cloudflare app.</p>}
        {data.cloudflare.auth_method === 'oauth' && data.cloudflare.status === 'connected' && <div className="stack">
          <h3>Direct image uploads</h3>
          <p>{data.cloudflare.media_ready ? 'R2 upload access is saved. You can replace the keys below when rotating access.' : 'Images upload directly from your browser to your R2 storage. Cloudflare requires a separate pair of R2 access keys for these uploads. Add them once for the whole organization.'}</p>
          {!data.cloudflare.cloudflare?.bucket ? <form onSubmit={event => void submit('cloudflare', event)}>
            <input type="hidden" name="action" value="prepare_media" /><button className="btn" disabled={busy}>Prepare media storage</button>
          </form> : <>
            <p>In Cloudflare, open <strong>Storage &amp; databases → R2 object storage → Overview → Account Details → API Tokens → Manage</strong>. Create an R2 token with <strong>Object Read &amp; Write</strong> limited to <strong>{data.cloudflare.cloudflare.bucket}</strong>. Copy its two S3 credentials below.</p>
            <form className="stack" onSubmit={event => void submit('cloudflare', event)} autoComplete="off">
              <input type="hidden" name="action" value="save_media" />
              <div className="field"><label htmlFor="oauth-r2-access">R2 Access Key ID</label><input id="oauth-r2-access" name="access_key_id" type="password" required autoComplete="new-password" maxLength={512} /></div>
              <div className="field"><label htmlFor="oauth-r2-secret">R2 Secret Access Key</label><input id="oauth-r2-secret" name="secret_access_key" type="password" required autoComplete="new-password" maxLength={512} /></div>
              <button className="btn" disabled={busy}>Verify image uploads</button>
            </form>
          </>}
        </div>}
        {data.cloudflare.credentials_saved && data.cloudflare.auth_method !== 'oauth' && <p>API and R2 credentials are saved and hidden. To rotate them, open the advanced connection settings below.</p>}
        <details><summary>Advanced: connect with existing API and R2 keys</summary><div className="stack">
        <p>Use a Cloudflare token scoped to your account with Cloudflare Pages: Edit, Account Settings: Read, and Workers R2 Storage: Edit. Create an R2 bucket and Object Read &amp; Write credentials restricted to that bucket.</p>
        <details><summary>Set up Cloudflare access</summary>
          <ol>
            <li>Open your account in <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare</a>. Go to <strong>Workers &amp; Pages → Create application → Pages → Connect to Git</strong> (also called <strong>Import an existing Git repository</strong>). Use <strong>+ Add account</strong> to authorize Cloudflare’s GitHub App for the same organization. Select <strong>All repositories</strong> so future sites are included. You can stop at the repository list.</li>
            <li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">My Profile → API Tokens</a>. Select <strong>Create Token → Create Custom Token → Get started</strong>. Add the three Account permissions listed above. Under <strong>Account Resources</strong>, choose <strong>Include → Specific account</strong> and your account. Select <strong>Continue to summary → Create Token</strong>, then copy the token into the form below.</li>
            <li>Open <strong>Storage &amp; databases → R2 object storage → Overview</strong>. Activate R2 if prompted. Select <strong>Create bucket</strong> and keep the default jurisdiction. Copy the bucket name into the form.</li>
            <li>Return to <strong>R2 → Overview → Account Details</strong>. Select <strong>Manage</strong> next to <strong>API Tokens</strong>, then <strong>Create Account API token</strong>. Choose <strong>Object Read &amp; Write</strong> for your bucket. Copy both <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> into the form. Account tokens require a Cloudflare Super Administrator.</li>
            <li>Select <strong>Verify and save Cloudflare</strong>. The status changes to <strong>connected</strong> after the access checks pass.</li>
          </ol>
          <p>You set this up once per organization. Repositories, Pages projects, build settings, and public image delivery belong to Typeroll’s site setup; you should not need to configure them for each site. That automatic site setup is still being completed.</p>
        </details>
        <p className="muted">Connect Cloudflare’s own GitHub App to the same organization with All repositories so Cloudflare can build your sites. The account check below verifies account access and Pages visibility, and uploads, reads, and deletes a small temporary R2 object. Project creation and public media delivery are verified separately.</p>
        {!data.encryption_available ? <p>The publisher needs to configure encrypted credential storage before you can connect.</p> :
          <form className="stack" onSubmit={(event) => void submit('cloudflare', event)} autoComplete="off">
            <div className="field"><label htmlFor="cf-account">Cloudflare Account ID</label><p id="cf-account-help" className="muted">Open <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare</a> and select your account. Use Search → Copy account ID. You can also find it in Workers &amp; Pages → Account Details → Account ID. Copy the 32-character value, not a Zone ID.</p><input aria-describedby="cf-account-help" id="cf-account" name="account_id" required pattern="[a-f0-9]{32}" maxLength={32} defaultValue={data.cloudflare.cloudflare?.account_id ?? ''} readOnly={Boolean(data.cloudflare.cloudflare)} /></div>
            <div className="field"><label htmlFor="r2-bucket">R2 bucket name</label><input id="r2-bucket" name="bucket" required maxLength={63} defaultValue={data.cloudflare.cloudflare?.bucket ?? ''} readOnly={Boolean(data.cloudflare.cloudflare)} /></div>
            <div className="field"><label htmlFor="cf-token">Cloudflare API token</label><input id="cf-token" name="api_token" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <div className="field"><label htmlFor="r2-access">R2 Access Key ID</label><input id="r2-access" name="access_key_id" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <div className="field"><label htmlFor="r2-secret">R2 Secret Access Key</label><input id="r2-secret" name="secret_access_key" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <button className="btn" disabled={busy} type="submit">{busy ? 'Checking connection…' : 'Verify and save Cloudflare'}</button>
          </form>}
        </div></details>
        {data.cloudflare.status === 'connected' && <button className="btn btn--secondary" disabled={busy} onClick={() => void disconnect('cloudflare')}>Disconnect Cloudflare</button>}
        <p className="muted">This first connection supports standard R2 buckets on the account’s global S3 endpoint. Disconnecting removes saved Cloudflare credentials. It does not delete your resources.</p>
      </section>
    </>}
  </div>;
}
