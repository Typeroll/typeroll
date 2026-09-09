import { useEffect, useRef, useState, type FormEvent } from 'react';
import PublishingCard from './PublishingCard';
import PublishingGithubPermissions from './PublishingGithubPermissions';

type Connection = {
  connected_at?: string | null;
  status: 'connected' | 'disconnected'; revision: string; credentials_saved: boolean;
  auth_method?: 'api_token' | 'oauth'; media_ready?: boolean;
  github: { owner: string } | null;
  cloudflare: { account_id: string; account_name: string; bucket: string; public_bucket?: string } | null;
};
type Connections = { media_migration?: { state: string; copied_files: number; pending_files: number; error: string | null } | null; cloudflare_choices?: Array<{ id: string; name: string }>; cloudflare_setup?: { available: boolean }; github_choices: Array<{ owner: string; installation_id: string }>; github: Connection; cloudflare: Connection; github_setup: { available: boolean; install_url: string | null }; encryption_available: boolean };
const API = '/api/orgs/publishing';

class PublishingRequestError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

async function request(path = '', method = 'GET', body?: unknown) {
  const response = await fetch(`${API}${path}`, { method, cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new PublishingRequestError(data.error || 'Could not update the publishing connection', data.code);
  return data;
}

export default function PublishingConnections() {
  const [data, setData] = useState<Connections | null>(null);
  const [disconnecting, setDisconnecting] = useState<'github' | 'cloudflare' | null>(null);
  const [connectionFeedback, setConnectionFeedback] = useState<{ provider: 'github' | 'cloudflare'; error: boolean; message: string } | null>(null);
  const metadataGeneration = useRef(0);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (connectionFeedback) { feedbackRef.current?.focus({ preventScroll: true }); feedbackRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' }); }
  }, [connectionFeedback]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mediaError, setMediaError] = useState<{ message: string; code?: string } | null>(null);
  const [mediaNotice, setMediaNotice] = useState('');
  const mediaFeedback = useRef<HTMLDivElement>(null);
  const checkedConnection = useRef<string | null>(null);
  const [checkingMedia, setCheckingMedia] = useState(false);
  useEffect(() => {
    if (mediaError || mediaNotice) {
      mediaFeedback.current?.focus({ preventScroll: true });
      mediaFeedback.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [mediaError, mediaNotice]);
  const refresh = async () => setData(await request());
  useEffect(() => {
    if (data?.cloudflare.status !== 'connected' || !['queued', 'running'].includes(data?.media_migration?.state ?? '')) return;
    let cancelled = false;
    const interval = setInterval(() => {
      const generation = metadataGeneration.current;
      void request().then(result => { if (!cancelled && generation === metadataGeneration.current) setData(result); })
        .catch(error => { if (!cancelled) setError(error.message); });
    }, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [data?.media_migration?.state, data?.cloudflare.status]);
  async function checkMedia(revision: string) {
    checkedConnection.current = revision;
    setCheckingMedia(true); setMediaError(null); setMediaNotice('');
    try {
      await request('/cloudflare', 'POST', { action: 'prepare_media', revision });
      await refresh();
      setMediaNotice('R2 is activated and your storage is prepared.');
    } catch (error) {
      // The provider check may have renewed OAuth before returning an R2 error.
      // Keep the retry bound to that new revision without triggering a loop.
      try {
        const latest = await request();
        checkedConnection.current = latest.cloudflare.revision;
        setData(latest);
      } catch { /* Keep the actionable setup error if metadata is unavailable. */ }
      setMediaError({ message: error instanceof Error ? error.message : 'Could not check R2. Try again.',
        code: error instanceof PublishingRequestError ? error.code : undefined });
    } finally { setCheckingMedia(false); }
  }
  useEffect(() => {
    const connection = data?.cloudflare;
    if (connection?.status === 'connected' && (!connection.cloudflare?.bucket || !connection.cloudflare?.public_bucket) && checkedConnection.current !== connection.revision) {
      void checkMedia(connection.revision);
    }
  }, [data?.cloudflare.revision, data?.cloudflare.status, data?.cloudflare.cloudflare?.bucket]);
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
    const mediaAction = provider === 'cloudflare' && values.action === 'save_media';
    setBusy(true); setError(''); setNotice('');
    if (provider === 'cloudflare') { setMediaError(null); setMediaNotice(''); }
    try {
      const result = await request(`/${provider}`, 'POST', { ...values, revision: data?.[provider].revision });
      if (result.authorization_url) { window.location.assign(result.authorization_url); return; }
      form.reset();
      await refresh();
      if (mediaAction) setMediaNotice('R2 connected. Upload access verified. Setup is complete.');
      else setNotice(provider === 'github' ? 'GitHub connected. This organization can be reused for your sites.' : 'Cloudflare connection updated. Access is encrypted and reused for your sites.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not complete setup. Check your connection and try again.';
      if (mediaAction) setMediaError({ message, code: error instanceof PublishingRequestError ? error.code : undefined });
      else setError(message);
    }
    finally { setBusy(false); }
  }

  async function disconnect(provider: 'github' | 'cloudflare') {
    const displayed = data?.[provider];
    if (!displayed) return;
    metadataGeneration.current++;
    setBusy(true); setDisconnecting(provider); setConnectionFeedback(null); setError(''); setNotice('');
    if (provider === 'cloudflare') { setMediaError(null); setMediaNotice(''); }
    try {
      // Token renewal changes the storage revision. Read it immediately before
      // disconnecting, while refusing to disconnect a newly selected account/grant.
      const latest: Connections = await request();
      const current = latest[provider];
      const identity = (value: Connection) => JSON.stringify([value.connected_at ?? null, provider === 'cloudflare' ? value.cloudflare?.account_id : value.github?.owner]);
      setData(latest);
      if (current.status === 'connected') {
        if (identity(current) !== identity(displayed)) throw new Error('The account connection changed in another session. Review the updated account before disconnecting.');
        await request(`/${provider}`, 'DELETE', { revision: current.revision });
      }
      // Reflect a successful disconnect even if a subsequent metadata read fails.
      setData({ ...latest, [provider]: { ...current, status: 'disconnected', credentials_saved: false, media_ready: false } });
      setConnectionFeedback({ provider, error: false, message: 'Disconnected. Existing repositories, deployments, and media remain in your account.' });
      if (provider === 'cloudflare') window.dispatchEvent(new Event('typeroll:publishing-connection-changed'));
    } catch (error) {
      setConnectionFeedback({ provider, error: true, message: error instanceof Error ? error.message : 'Could not disconnect. Try again.' });
    } finally { metadataGeneration.current++; setBusy(false); setDisconnecting(null); }
  }

  const mediaBucket = data?.cloudflare.cloudflare?.bucket;
  const cloudflareAccount = data?.cloudflare.cloudflare;
  const r2Overview = cloudflareAccount ? `https://dash.cloudflare.com/${cloudflareAccount.account_id}/r2/overview` : 'https://dash.cloudflare.com/';
  const mediaReady = Boolean(data?.cloudflare.status === 'connected' && data?.cloudflare.media_ready && mediaBucket && cloudflareAccount?.public_bucket);
  const mediaAccessForm = <div className="stack">
    <p>Paste your R2 upload keys to enable direct uploads.</p>
    <details><summary>How to create R2 upload keys</summary>
    <p>Create one R2 upload token in Cloudflare and paste its two keys below. This allows direct uploads from your browser to R2. The keys are saved only after writing, reading and deleting a test file succeeds in both buckets. You only do this once for all sites in this organization.</p>
    <a className="btn btn--secondary" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }} href={r2Overview} target="_blank" rel="noreferrer">Open R2 in {cloudflareAccount?.account_name} ↗</a>
    <ol style={{ paddingInlineStart: 24 }}>
      <li>In <strong>R2 object storage → Overview</strong>, find <strong>Account Details → API Tokens</strong> and select <strong>Manage</strong>.</li>
      <li>Select <strong>Create Account API token</strong> and name it <strong>Typeroll media</strong>. If that option is unavailable, use <strong>Create User API token</strong>.</li>
      <li>Choose <strong>Object Read &amp; Write</strong> and restrict access to these two Typeroll buckets: <strong style={{ overflowWrap: 'anywhere' }}>{mediaBucket}</strong> (private originals) and <strong style={{ overflowWrap: 'anywhere' }}>{cloudflareAccount?.public_bucket ?? 'the public bucket shown after preparing storage'}</strong> (published images).</li>
      <li>Create the token. Copy <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> into the matching fields below. The secret is shown only once.</li>
    </ol>
    <p className="muted">Copy Access Key ID and Secret Access Key, not the value labelled API token.</p>
    <details><summary>Cannot create an Account API token?</summary><p>Account tokens require a Cloudflare Super Administrator. A User API token also works, but becomes inactive if its owner is removed from the Cloudflare account.</p></details>
    </details>
    <form className="stack" onSubmit={event => void submit('cloudflare', event)} autoComplete="off">
      <input type="hidden" name="action" value="save_media" />
      <div className="field"><label htmlFor="oauth-r2-access">R2 Access Key ID</label><input id="oauth-r2-access" name="access_key_id" type="password" required autoComplete="new-password" maxLength={512} /></div>
      <div className="field"><label htmlFor="oauth-r2-secret">R2 Secret Access Key</label><input id="oauth-r2-secret" name="secret_access_key" type="password" required autoComplete="new-password" maxLength={512} /></div>
      <button className="btn" disabled={busy || checkingMedia}>{busy ? 'Verifying R2 access…' : 'Verify keys and finish setup'}</button>
    </form>
  </div>;

  return <div style={{ maxWidth: 760 }} aria-busy={busy || checkingMedia}>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <>{['GitHub account', 'Cloudflare account', 'Media storage'].map((title, index) => <PublishingCard key={title} id={`loading-${index}`} title={title} state={error ? 'error' : 'waiting'} status={error ? 'Could not load settings' : 'Loading…'}><p className="muted">{error ? 'Reload the page to try again.' : 'Checking your organization’s settings.'}</p></PublishingCard>)}</> : <>
      <PublishingCard id="github" title="GitHub account" state={disconnecting === 'github' ? 'waiting' : connectionFeedback?.provider === 'github' && connectionFeedback.error ? 'error' : data.github.status === 'connected' ? 'ready' : 'error'} status={disconnecting === 'github' ? 'Disconnecting…' : connectionFeedback?.provider === 'github' && connectionFeedback.error ? 'Connection needs attention' : data.github.status === 'connected' ? `Connected · ${data.github.github?.owner ?? 'GitHub'}` : 'Not connected'}>
        <p>Stores a private repository for each site and its version branches.</p>
        {!data.github_setup.available ? <p>The publisher needs to configure its GitHub App before you can connect.</p> : <>

          {(data.github_choices ?? []).length > 0 && <form className="stack" onSubmit={(event) => void submit('github', event)}>
            <div className="field"><label htmlFor="github-organization">Choose a GitHub organization</label>
              <select id="github-organization" name="installation_id" required defaultValue="">
                <option value="" disabled>Select an organization</option>
                {data.github_choices.map(choice => <option key={choice.installation_id} value={choice.installation_id}>{choice.owner} — github.com/{choice.owner}</option>)}
              </select></div>
            <button className="btn" disabled={busy || checkingMedia} type="submit">Connect selected organization</button>
          </form>}
          {data.github.status === 'connected' ? <PublishingGithubPermissions revision={data.github.revision} /> : <form className="stack" onSubmit={(event) => void submit('github', event)}>
            <button className="btn" disabled={busy || checkingMedia} type="submit">Connect GitHub</button>
          </form>}
          <details><summary>GitHub setup instructions</summary>
            <p>Sign in and choose an organization you own. No organization name or ID needs to be entered.</p>
            <ol>
              <li><a href={data.github_setup.install_url!} target="_blank" rel="noreferrer">Open the App installation in GitHub</a> and select your organization.</li>
              <li>Select <strong>All repositories</strong> and approve the requested permissions. This also includes repositories Typeroll creates for future sites.</li>
              <li>Return here and select <strong>Connect GitHub</strong>. If you already installed the App, start with that button.</li>
            </ol>
          </details>
        </>}
        {data.github.status === 'connected' && <button className="btn btn--secondary" disabled={busy || checkingMedia} onClick={() => void disconnect('github')}>{disconnecting === 'github' ? 'Disconnecting…' : 'Disconnect GitHub'}</button>}
        {connectionFeedback?.provider === 'github' && <p ref={feedbackRef} tabIndex={-1} role={connectionFeedback.error ? 'alert' : 'status'}>{connectionFeedback.message}</p>}
      </PublishingCard>
      <PublishingCard id="cloudflare" title="Cloudflare account" state={disconnecting === 'cloudflare' ? 'waiting' : connectionFeedback?.provider === 'cloudflare' && connectionFeedback.error ? 'error' : data.cloudflare.status === 'connected' ? 'ready' : 'error'} status={disconnecting === 'cloudflare' ? 'Disconnecting…' : connectionFeedback?.provider === 'cloudflare' && connectionFeedback.error ? 'Connection needs attention' : data.cloudflare.status === 'connected' ? `Connected · ${cloudflareAccount?.account_name ?? 'Cloudflare'}` : 'Not connected'}>
        <p>Builds and hosts your sites. One account is shared by this organization’s sites.</p>
        {data.cloudflare.status === 'connected' && <details><summary>Allow Cloudflare to build from GitHub — once per organization</summary><ol>
          <li>Open Cloudflare → Workers &amp; Pages → Create application → Pages → Connect to Git.</li>
          <li>Select + Add account, choose the same GitHub organization as above, and authorize Cloudflare’s GitHub App with All repositories.</li>
          <li>Stop at the repository list and return here. Typeroll creates each site’s repository and Pages project.</li>
        </ol><p>This authorization is separate from installing the Typeroll GitHub App. Future sites reuse it.</p></details>}

        {data.cloudflare_setup?.available ? <>
          {(data.cloudflare_choices ?? []).length > 0 && <form className="stack" onSubmit={event => void submit('cloudflare', event)}>
            <input type="hidden" name="action" value="select" />
            <div className="field"><label htmlFor="cf-choice">Choose a Cloudflare account</label>
              <select id="cf-choice" name="account_id" required defaultValue=""><option value="" disabled>Select an account</option>
                {data.cloudflare_choices!.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select></div><button type="submit" className="btn" disabled={busy || checkingMedia}>Connect selected account</button>
          </form>}
          <form onSubmit={event => void submit('cloudflare', event)}><input type="hidden" name="action" value="start" />
            {data.cloudflare.status === 'connected' ? <details><summary>Reconnect Cloudflare</summary>
              <p>Use this if your account authorization needs to be renewed. Include the optional domain, DNS, Cache Purge and URL rewrite permissions if you want Typeroll to configure your domains automatically.</p><button type="submit" className="btn" disabled={busy || checkingMedia}>Sign in to Cloudflare again</button>
            </details> : <button type="submit" className="btn" disabled={busy || checkingMedia}>Connect Cloudflare</button>}
          </form>
        </> : <p className="muted">Cloudflare sign-in is not available until the publisher finishes configuring its Cloudflare app.</p>}
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
          <p>You set this up once per organization. For sites using Git publishing, Typeroll creates the repository and Pages project at the first deployment. Finish R2 setup in Media storage below for both the private originals bucket and the public images bucket.</p>
        </details>
        <p className="muted">Connect Cloudflare’s own GitHub App to the same organization with All repositories so Cloudflare can build your sites. The account check below verifies account access and Pages visibility, and uploads, reads, and deletes a small temporary R2 object. Project creation and public media delivery are verified separately.</p>
        {!data.encryption_available ? <p>The publisher needs to configure encrypted credential storage before you can connect.</p> :
          <form className="stack" onSubmit={(event) => void submit('cloudflare', event)} autoComplete="off">
            <div className="field"><label htmlFor="cf-account">Cloudflare Account ID</label><p id="cf-account-help" className="muted">Open <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare</a> and select your account. Use Search → Copy account ID. You can also find it in Workers &amp; Pages → Account Details → Account ID. Copy the 32-character value, not a Zone ID.</p><input aria-describedby="cf-account-help" id="cf-account" name="account_id" required pattern="[a-f0-9]{32}" maxLength={32} defaultValue={data.cloudflare.cloudflare?.account_id ?? ''} readOnly={Boolean(data.cloudflare.cloudflare)} /></div>
            <div className="field"><label htmlFor="r2-bucket">R2 bucket name</label><input id="r2-bucket" name="bucket" required maxLength={63} defaultValue={data.cloudflare.cloudflare?.bucket ?? ''} readOnly={Boolean(data.cloudflare.cloudflare)} /></div>
            <div className="field"><label htmlFor="cf-token">Cloudflare API token</label><input id="cf-token" name="api_token" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <div className="field"><label htmlFor="r2-access">R2 Access Key ID</label><input id="r2-access" name="access_key_id" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <div className="field"><label htmlFor="r2-secret">R2 Secret Access Key</label><input id="r2-secret" name="secret_access_key" type="password" required maxLength={512} autoComplete="new-password" /></div>
            <button className="btn" disabled={busy || checkingMedia} type="submit">{busy ? 'Checking connection…' : 'Verify and save Cloudflare'}</button>
          </form>}
        </div></details>
        {data.cloudflare.status === 'connected' && <button className="btn btn--secondary" disabled={busy || checkingMedia} onClick={() => void disconnect('cloudflare')}>{disconnecting === 'cloudflare' ? 'Disconnecting…' : 'Disconnect Cloudflare'}</button>}
        {connectionFeedback?.provider === 'cloudflare' && <p ref={feedbackRef} tabIndex={-1} role={connectionFeedback.error ? 'alert' : 'status'}>{connectionFeedback.message}</p>}
        <details><summary>About this connection</summary><p>Disconnecting removes saved Cloudflare credentials. Your repositories, deployments and media remain in your accounts. Media storage uses standard R2 buckets on the account’s global S3 endpoint.</p></details>
      </PublishingCard>
      <PublishingCard id="media" title="Media storage"
        state={checkingMedia ? 'waiting' : mediaError || !mediaReady || data.media_migration?.state === 'failed' ? 'error' : ['queued', 'running'].includes(data.media_migration?.state ?? '') ? 'waiting' : 'ready'}
        status={checkingMedia ? 'Checking storage…' : data.cloudflare.status !== 'connected' ? 'Cloudflare connection required' : mediaError ? 'Storage needs attention' : !mediaReady ? 'Setup required' : data.media_migration?.state === 'failed' ? 'Migration needs attention' : ['queued', 'running'].includes(data.media_migration?.state ?? '') ? 'Moving media to R2…' : 'R2 connected'}>
        {data.cloudflare.status === 'connected' ? <div className="stack">
          {(mediaError || mediaNotice) && <div ref={mediaFeedback} tabIndex={-1} role={mediaError ? 'alert' : 'status'} className="stack" style={{ padding: 16, border: `2px solid var(${mediaError ? '--color-danger' : '--color-success'})`, borderRadius: 8, scrollMarginTop: 72 }}>
            {mediaError?.code === 'r2_activation_required' ? <>
              <strong>R2 is not activated for {cloudflareAccount?.account_name}</strong>
              <details><summary>How to activate R2</summary><p>Open <strong>Storage &amp; databases → R2 object storage → Overview</strong> in the account below and complete the R2 subscription checkout. Enter billing details if Cloudflare asks for them.</p>
              <a href={r2Overview} target="_blank" rel="noreferrer">Open R2 activation in {cloudflareAccount?.account_name} ↗</a>
              <p>Return here and confirm below. Typeroll checks that activation is complete before continuing. You do not need to create a bucket or reconnect Cloudflare.</p></details>
            </> : <p style={{ overflowWrap: 'anywhere' }}>{mediaError?.message || mediaNotice}</p>}
          </div>}
          {mediaReady ? <>
            <p>Upload access verified. Your R2 credentials are saved securely and reused for this organization’s sites.</p>
            <details><summary>Storage details</summary><p>Private originals bucket: <strong style={{ overflowWrap: 'anywhere' }}>{mediaBucket}</strong></p>
            <p>Public images bucket: <strong style={{ overflowWrap: 'anywhere' }}>{cloudflareAccount?.public_bucket}</strong></p></details>
            {data.media_migration && <div role="status">
              <p>{data.media_migration.state === 'complete' ? data.media_migration.copied_files === 0 ? 'No existing media to move. New uploads go directly to R2.' : 'Originals moved to your R2 storage. Existing published image URLs are retained.' : `${data.media_migration.state === 'failed' ? 'Media migration paused' : 'Moving existing originals to R2'}: ${data.media_migration.copied_files} copied, ${data.media_migration.pending_files} remaining.`}</p>
              {data.media_migration.error && <><p>Media migration needs attention. Check Domains below, then retry.</p><details><summary>Migration error details</summary><p>{data.media_migration.error}</p></details></>}
              {data.media_migration.state !== 'complete' && <button type="button" className="btn" disabled={busy} onClick={async () => {
                setBusy(true); setError('');
                try { if (data.media_migration?.state === 'failed') await request('/media-migration', 'POST', {}); await refresh(); }
                catch (error) { setError(error instanceof Error ? error.message : 'Could not check migration.'); }
                finally { setBusy(false); }
              }}>{data.media_migration.state === 'failed' ? 'Retry media migration' : 'Refresh migration status'}</button>}
            </div>}
            {data.cloudflare.auth_method === 'oauth' && <details><summary>Replace R2 access keys</summary>{mediaAccessForm}</details>}
          </> : mediaBucket ? <>
            <p>R2 storage prepared</p>
            <p>Bucket: <strong style={{ overflowWrap: 'anywhere' }}>{mediaBucket}</strong></p>
            <h4>Finish R2 setup</h4>
            {mediaAccessForm}
          </> : <>
            {checkingMedia && <p role="status">Checking R2 and preparing your storage…</p>}
            {mediaError && <button className="btn" style={{ whiteSpace: 'normal' }} disabled={busy || checkingMedia} onClick={() => void checkMedia(data.cloudflare.revision)}>
              {mediaError.code === 'r2_activation_required' ? 'I’ve activated R2 — check again' : 'Check R2 again'}
            </button>}
          </>}
        </div> : <p>Connect your Cloudflare account above to set up direct media uploads.</p>}
      </PublishingCard>
    </>}
  </div>;
}
