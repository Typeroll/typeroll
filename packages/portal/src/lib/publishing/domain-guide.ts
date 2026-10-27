import { buildMigrationLaunchReport } from '../migration-launch-report';
import { Resolver } from 'node:dns/promises';
import { paths, pagesRedirectsFile } from '@typeroll/shared';
import { checkPagesRedirects, PAGES_REDIRECT_LIMITS } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getSiteDomains, saveSiteDomains, approveDomainCutover } from './domain-config';
import { domainChangeImpact } from './domain-impact';
import { prepareDomainTransition } from './domain-transition';
import { checkPublicationHosts, siteZoneSources } from './host-checks';
import { findZone } from './domain-provider';
import { publishingReadiness } from './readiness';
import { resolvePublicationVersion } from './publication-version';
import { cloudflarePermissionReport } from './cloudflare-capabilities';
import { siteHostingGroup } from './hosting-groups';
import { readDomainCutover, requestDomainRollback } from './domain-cutover-journal';
import { ConnectionError } from './connections';

type Check = { id: string; status: 'ready' | 'waiting' | 'action_required' | 'external'; message: string; details?: unknown };

/** One site-scoped contract for the portal and external agents. No read starts a publication or edits DNS. */
export async function readDomainGuide(org: string, site: string) {
  const config = await getSiteDomains(org, site), group = await siteHostingGroup(org, site);
  const checks: Check[] = [];
  const sources = await siteZoneSources(org, site);
  const hosts = await checkPublicationHosts(config.desired, config.dns_mode, sources);
  checks.push({ id: 'hosting_account', status: sources.some(source => source.account === 'hosting') ? 'ready' : 'action_required', message: sources.some(source => source.account === 'hosting') ? 'The Hosting Group account is connected.' : 'Connect Cloudflare in Organization → Publishing.', details: { hosting_group_id: group.id, account_id: sources.find(source => source.account === 'hosting')?.accountId ?? null } });
  checks.push({ id: 'host_requirements', status: hosts.blockers.length ? 'action_required' : hosts.warnings.length ? 'waiting' : config.desired.website_host ? 'ready' : 'action_required', message: hosts.blockers[0]?.message ?? hosts.warnings[0]?.message ?? (config.desired.website_host ? 'The website and redirect hosts are supported.' : 'Save the future website address.'), details: hosts });
  for (const host of hosts.hosts) {
    const source = sources.find(source => source.account === host.zone?.account);
    if (!source || !host.zone) continue;
    const zone = await findZone(source.provider, source.accountId, host.host);
    if (!zone) continue;
    try {
      const resolver = new Resolver({ timeout: 3000, tries: 1 });
      const actual = (await resolver.resolveNs(zone.name)).map(value => value.toLowerCase().replace(/\.$/, '')).sort();
      const expected = [...zone.name_servers ?? []].map(value => value.toLowerCase().replace(/\.$/, '')).sort();
      checks.push({ id: `nameservers:${host.host}`, status: expected.length && JSON.stringify(actual) === JSON.stringify(expected) ? 'ready' : 'action_required',
        message: `At your registrar, use these nameservers for ${zone.name}: ${expected.join(', ') || 'not yet assigned'}. Keep all existing mail and website records DNS only until reviewed.`, details: { actual, expected } });
    } catch { checks.push({ id: `nameservers:${host.host}`, status: 'waiting', message: `Nameservers for ${zone.name} could not be verified. Retry the check; no registrar changes were made.` }); }
    try {
      const packs = await source.provider(`/zones/${zone.id}/ssl/verification`);
      const active = Array.isArray(packs) && packs.some((pack: any) => pack.certificate_status === 'active' && (!pack.hosts || pack.hosts.includes(host.host) || pack.hosts.includes(`*.${zone.name}`) && host.host.split('.').length === zone.name.split('.').length + 1));
      checks.push({ id: `certificate:${host.host}`, status: active ? 'ready' : 'waiting', message: active ? `Cloudflare reports an active edge certificate for ${host.host}.` : `Wait for Cloudflare to issue the edge certificate for ${host.host}. Existing traffic stays in place.` });
    } catch { checks.push({ id: `certificate:${host.host}`, status: 'action_required', message: 'The connection could not read certificate status. Check SSL/TLS → Edge Certificates in Cloudflare or update its SSL read permission.' }); }
  }
  try {
    const permissions = await cloudflarePermissionReport(org, group.id);
    const relevant = permissions.capabilities.filter(item => item.capability === 'redirect_rules' && config.desired.redirect_hosts?.length);
    checks.push({ id: 'permissions', status: relevant.some(item => ['approval_required', 'not_offered', 'connection_required'].includes(item.status)) ? 'action_required' : 'ready', message: relevant.find(item => item.next_step)?.next_step ?? 'The connected account is used for all provider operations. Provider checks report missing permissions before traffic changes.', details: permissions });
  } catch { checks.push({ id: 'permissions', status: 'waiting', message: 'Connection permissions could not be checked. Retry from Organization → Publishing.' }); }
  try {
    const readiness = await publishingReadiness(org, site);
    checks.push({ id: 'publishing_ready', status: readiness.ready ? 'ready' : 'action_required', message: readiness.ready ? 'Publishing setup is ready.' : readiness.required.map(item => item.message).join(' '), details: readiness });
  } catch (error) { checks.push({ id: 'publishing_ready', status: 'action_required', message: error instanceof Error ? error.message : 'Publishing setup could not be checked.' }); }
  try {
    const publication = await resolvePublicationVersion(org, site, 'main');
    const content = pagesRedirectsFile(publication.redirects, publication.settings ?? {}, { domain: config.desired.website_host ?? undefined });
    checks.push({ id: 'redirect_capacity', status: 'ready', message: 'Redirect rules fit Cloudflare Pages limits after expansion.', details: { ...checkPagesRedirects(content), limits: PAGES_REDIRECT_LIMITS, bytes: Buffer.byteLength(content) } });
  } catch (error) { checks.push({ id: 'redirect_capacity', status: 'action_required', message: error instanceof Error ? error.message : 'The publication could not be exported.' }); }
  const inventory = await getStore().listDocs(paths.migrationUrls(org, site));
  if (inventory.length) {
    try {
      const siteRecord = await getStore().getDoc<any>(paths.site(org, site));
      const launch = await buildMigrationLaunchReport({ store: getStore(), orgId: org, siteId: site, versionId: 'main', site: { ...siteRecord, id: site } });
      checks.push({ id: 'launch_ready', status: launch.launch_ready ? 'ready' : 'action_required', message: launch.launch_ready ? 'Migration launch checks passed.' : launch.issues.map(issue => issue.detail).join(' '), details: launch });
    } catch { checks.push({ id: 'launch_ready', status: 'waiting', message: 'Migration launch evidence could not be checked. Open Migration and refresh its launch report.' }); }
  }
  const lastPublication = (await getStore().getDoc<any>(`${paths.site(org, site)}/publishing_targets/main`))?.last_publication;
  const currentJobId = config.published?.job_id ?? (config.published?.publication_id === lastPublication?.publication_id
    ? lastPublication?.snapshot_job_id ?? config.candidate?.job_id : config.candidate?.job_id);
  const job = currentJobId ? await getStore().getDoc<any>(paths.deploy(org, site, currentJobId)) :
    (await getStore().listDocs<any>(paths.deploys(org, site))).filter(item => item.publication_intent === 'domain_prepare').sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
  const publishedMain = Boolean(config.candidate && config.published?.publication_id === config.candidate.id && lastPublication?.publication_id === config.candidate.id);
  checks.push({ id: 'candidate', status: job?.status === 'failed' ? 'action_required' : publishedMain && config.state === 'ready_to_switch' ? 'ready' : 'waiting', message: job?.error || (job?.phase === 'awaiting domain cutover approval' ? 'The main site is published with the new addresses. DNS is still pending.' : job?.phase) || 'Publish the last published content again with the new addresses. This replaces main before DNS changes.', details: { candidate_id: config.candidate?.id ?? null, job_id: job?.id ?? null } });
  const cutover = config.candidate ? await readDomainCutover(org, site, config.candidate.id) : null;
  const canPrepare = checks.filter(check => ['hosting_account', 'host_requirements', 'publishing_ready', 'redirect_capacity'].includes(check.id)).every(check => check.status !== 'action_required');
  return { ...config, published_main: publishedMain, can_prepare: canPrepare, elapsed_seconds: job?.started_at ? Math.max(0, Math.round((Date.parse(job.finished_at ?? new Date().toISOString()) - Date.parse(job.started_at)) / 1000)) : null, title: `Move site to ${config.desired.website_host ?? 'your domain'}`, checks,
    current_phase: config.rollback_status === 'rolled_back' ? 'previous traffic restored' : (job?.phase === 'awaiting domain cutover approval' ? 'Published; DNS switch pending' : job?.phase) ?? ({ unconfigured: 'Save a website address to begin', declared: 'Ready to publish for the new domain', preparing: 'Preparing and checking requirements', ready_to_switch: 'Ready for your approval', distributing: 'Switching and verifying traffic', live: 'Public traffic verified', failed: 'Needs attention', outdated: 'Publish for the new domain to replace this older preparation.' }[config.state]),
    traffic_live: config.state === 'live', next_action: config.state === 'live' ? 'none' : config.state === 'distributing' ? 'wait' : config.state === 'ready_to_switch' && publishedMain ? 'approve' : !lastPublication ? 'publish_first' : publishedMain ? 'refresh' : 'prepare',
    cutover: cutover ? { state: cutover.state, deadline_at: cutover.deadline_at, errors: cutover.errors, previous_records: cutover.entries.map(entry => ({ hostname: entry.hostname, records: entry.before })) } : null,
    switch_summary: { website: config.preparation, media: config.media_preparation, redirects: config.redirect_preparations, validation_timeout_minutes: config.validation_timeout_minutes ?? 15,
      interruption: config.preparation?.validation_blocker?.message ?? 'The same main publication already serves at the current address. This step changes DNS without another build or upload. DNS propagation and provider validation can still take time.',
      rollback: config.dns_mode === 'automatic' ? 'Typeroll records the previous DNS and restores it on failed verification or deadline. This does not restore an older site publication. Later external edits stop automatic restoration and are reported.' : 'Your DNS administrator or agent applies and restores external DNS. Typeroll verifies the result.' } };
}

export async function domainGuideAction(org: string, site: string, input: Record<string, unknown>) {
  switch (input.action) {
    case 'check': return readDomainGuide(org, site);
    case 'preview': return domainChangeImpact(org, site, input);
    case 'save': return saveSiteDomains(org, site, input);
    case 'prepare': return prepareDomainTransition(org, site, input);
    case 'approve': return approveDomainCutover(org, site, input);
    case 'rollback': return requestDomainRollback(org, site, await getSiteDomains(org, site), input);
    default: throw new ConnectionError('Choose check, preview, save, prepare, approve or rollback.', 400, 'invalid_domain_action');
  }
}
