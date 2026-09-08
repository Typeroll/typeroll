import { getOrganizationDomains, publicationHostname } from './domain-config';
import { getConnection, connectionSummary } from './connections';
import { cloudflareClient } from './cloudflare-oauth';

type Step = { title: string; description: string; url?: string };
export interface OrganizationDomainStatus {
  state: 'not_configured' | 'cloudflare_required' | 'storage_required' | 'setup_required' | 'pending' | 'active' | 'check_failed';
  checked_at: string;
  hostname: string | null;
  message: string;
  account_id: string | null;
  account_name: string | null;
  public_bucket: string | null;
  ownership: string | null;
  certificate: string | null;
  zone: { name: string; type: 'full' | 'partial' | 'unknown'; status: string } | null;
  zone_check: 'not_checked' | 'found' | 'not_found' | 'unavailable';
  steps: Step[];
}
const bucketGuide = 'https://developers.cloudflare.com/r2/buckets/public-buckets/#connect-a-bucket-to-a-custom-domain';
const partialGuide = 'https://developers.cloudflare.com/dns/zone-setups/partial-setup/setup/';
const fullGuide = 'https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-subdomain/';
const ownershipStates = new Set(['pending', 'active', 'deactivated', 'blocked', 'error', 'unknown']);
const certificateStates = new Set(['initializing', 'pending', 'active', 'deactivated', 'error', 'unknown']);

/** Read provider state without writing DNS, attaching hosts or retrying media migration. */
export async function getOrganizationDomainStatus(orgId: string) {
  const [domains, connection] = await Promise.all([getOrganizationDomains(orgId), getConnection(orgId, 'cloudflare')]);
  const cf = connection.status === 'connected' ? connection.cloudflare : undefined;
  const status: OrganizationDomainStatus = {
    state: 'not_configured', hostname: domains.media_host, checked_at: new Date().toISOString(), message: 'Save a shared media hostname to start media domain setup.',
    account_id: cf?.account_id ?? null, account_name: cf?.account_name ?? null, public_bucket: cf?.public_bucket ?? null,
    ownership: null, certificate: null, zone: null, zone_check: 'not_checked', steps: [],
  };
  const result = () => ({ ...domains, domain_status: status });
  if (!domains.media_host) return result();
  const host = publicationHostname(domains.media_host);
  if (!cf) {
    status.state = 'cloudflare_required'; status.message = 'Connect the organization’s Cloudflare account in Publishing before setting up this domain.';
    return result();
  }
  if (!connectionSummary(connection).media_ready || !cf.public_bucket) {
    status.state = 'storage_required'; status.message = 'Complete the R2 media storage setup in Publishing first. Saving a domain does not activate storage.';
    return result();
  }
  const accountUrl = `https://dash.cloudflare.com/${encodeURIComponent(cf.account_id)}`;
  const bucketUrl = `${accountUrl}/r2/default/buckets/${encodeURIComponent(cf.public_bucket)}/settings`;
  let domain: any = null;
  try {
    const provider = await cloudflareClient(orgId, fetch, connection.revision);
    domain = await provider(`/accounts/${cf.account_id}/r2/buckets/${encodeURIComponent(cf.public_bucket)}/domains/custom/${encodeURIComponent(host)}`, { missing: true });
    // Zone-read is optional for customers whose own agent manages DNS. Its absence must not invalidate an active R2 host.
    try {
      const labels = host.split('.');
      status.zone_check = 'not_found';
      for (let offset = 0; offset < labels.length - 1; offset++) {
        const name = labels.slice(offset).join('.');
        const zones = await provider(`/zones?account.id=${encodeURIComponent(cf.account_id)}&name=${encodeURIComponent(name)}&per_page=50`);
        const zone = zones.find((candidate: any) => candidate.name === name && candidate.account?.id === cf.account_id);
        if (zone) {
          status.zone = { name, type: ['full', 'partial'].includes(zone.type) ? zone.type : 'unknown', status: zone.status === 'active' ? 'active' : 'pending' };
          status.zone_check = 'found'; break;
        }
      }
    } catch { status.zone_check = 'unavailable'; }
    status.ownership = ownershipStates.has(domain?.status?.ownership) ? domain.status.ownership : 'unknown';
    status.certificate = certificateStates.has(domain?.status?.ssl) ? domain.status.ssl : 'unknown';
    if (domain?.enabled === true && status.ownership === 'active' && status.certificate === 'active') {
      status.state = 'active'; status.message = 'Cloudflare has activated this media domain and its HTTPS certificate. Each deployment also verifies its published media URLs before going live.';
    } else if (domain?.enabled === true) {
      status.state = 'pending'; status.message = ['error', 'blocked', 'deactivated'].includes(status.ownership ?? 'unknown') || ['error', 'deactivated'].includes(status.certificate ?? 'unknown')
        ? 'Cloudflare reports a domain or certificate problem. Open the public bucket’s Custom Domains settings to review and retry the connection.'
        : 'The media domain is connected to R2, but Cloudflare has not confirmed domain ownership and HTTPS yet. Complete any required DNS records, then check again.';
    } else {
      status.state = 'setup_required'; status.message = domain ? 'This media domain is disabled in the public R2 bucket. Enable it in Cloudflare, then check again.'
        : status.zone_check === 'not_found' ? 'The media domain is not connected to R2, and no matching domain was found in the connected Cloudflare account.'
          : 'This media domain is not connected to the organization’s public R2 bucket yet.';
    }
  } catch (error) {
    status.state = 'check_failed';
    const httpStatus = error && typeof error === 'object' && 'status' in error ? error.status : null;
    status.message = httpStatus === 401 || httpStatus === 403
      ? 'Cloudflare denied access to the R2 domain settings. Check the R2 permissions granted to Typeroll, then check again. Your saved domain has not been changed.'
      : 'Could not read Cloudflare domain status. Check the Cloudflare connection and try again. This does not mean that the domain is disconnected.';
  }
  if (domains.dns_mode === 'automatic' && status.zone?.type === 'full' && status.zone.status === 'active') {
    if (status.state === 'pending' && !['error', 'blocked', 'deactivated'].includes(status.ownership ?? '') && !['error', 'deactivated'].includes(status.certificate ?? '')) {
      status.message = 'The media domain is connected to R2. Cloudflare is activating HTTPS; Typeroll checks progress automatically.';
    }
    status.steps = [{ title: 'Configure in Typeroll', description: 'Select this Cloudflare domain above, enter the media and sites subdomains, then select Configure domains. Typeroll connects media to R2 and checks activation automatically. Each site and version gets its own website address when you publish.' }];
    return result();
  }
  if (status.zone_check === 'unavailable') status.steps.push({ title: 'Domain access could not be checked', description: 'Typeroll could not read Cloudflare zone settings. Check the domain in the connected account yourself, or use Allow domain access in Publishing if additional approval is required. R2 domain status is checked separately.' });
  if (status.zone?.type !== 'partial') status.steps.push({ title: 'If DNS is hosted by Cloudflare',
    description: `In Cloudflare, select the connected account (${cf.account_name}) → Domains → your domain. It must be Active in this same account. Only the chosen hostnames are used for Typeroll. Your root domain, email and other subdomains can continue pointing to their existing services.`, url: fullGuide });
  if (status.zone?.type !== 'full') status.steps.push({ title: 'If DNS is hosted by another provider',
    description: 'Keep your current nameservers, root website, email and other services. Add the domain to this Cloudflare account with a partial (CNAME) setup for only the selected hostnames. This requires Cloudflare Business or Enterprise for the domain. Follow Cloudflare’s verification instructions and add the exact TXT and CNAME records it supplies at your current DNS provider. A CNAME to the R2 storage API endpoint will not work.', url: partialGuide });
  status.steps.push({ title: domains.dns_mode === 'automatic' ? 'Automatic media domain setup' : 'Connect the media domain',
    description: domains.dns_mode === 'automatic'
      ? `Once the domain is Active in this account, Save domain settings starts or retries automatic setup for ${host}. Typeroll requires R2 and DNS permissions. Existing A, AAAA and CNAME records are not overwritten automatically.`
      : `In Cloudflare → R2 object storage → ${cf.public_bucket} → Settings → Custom Domains → Add, enter ${host}, select Continue, review the record and select Connect Domain. Use the public bucket shown here, not the private originals bucket.`, url: bucketUrl });
  if (domains.dns_mode === 'external') status.steps.push({ title: 'Apply DNS records and verify', description: 'In the connected domain’s menu, select Manage DNS to see the record. If you use partial setup, follow Cloudflare’s instructions for the CNAME at your external DNS provider. Copy the full names and values exactly. You or your AI agent can do this. Return here and select Check domain status.', url: bucketGuide });
  status.steps.push({ title: 'Website addresses are configured separately', description: 'This check covers the organization’s shared media hostname. Each site’s Publishing settings show its website and media hosts, DNS requirements and deployment verification. Version addresses are verified when that version is deployed.' });
  // Status belongs to this snapshot only; do not persist a stale check over a concurrent settings change.
  return result();
}
