import { randomUUID } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from './connections';
import { hostingDns } from './hosting-dns';
import { trafficFingerprint, type DomainPreparation } from './domain-provider';
import { REDIRECT_PHASE, type RedirectPreparation } from './redirect-hosts';
import { siteDomainConfigPath, type DomainConfiguration } from './domain-config';

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
type Entry = { hostname: string; group_id: string; account_id: string; zone_id: string; before: any[]; after: any[] | null; dns_intent?: Record<string, any>; rule_intent?: Record<string, any>; redirect?: RedirectPreparation; rules_before?: any; rules_after?: any };
export interface CutoverJournal { revision: string; candidate_id: string; state: 'armed' | 'live' | 'rolling_back' | 'rolled_back' | 'conflict'; deadline_at: number; entries: Entry[]; previous_active: DomainConfiguration['active']; previous_hosts?: DomainConfiguration['previous_hosts']; previous_publication?: any; previous_version?: any; previous_site?: any; errors: string[] }
const journalPath = (org: string, site: string, candidate: string) => `${paths.site(org, site)}/domain_cutovers/${candidate}`;
const writable = ['type', 'name', 'content', 'ttl', 'proxied', 'comment', 'tags', 'settings', 'priority', 'data'];
export function dnsRecordBody(record: any) { return Object.fromEntries(writable.filter(key => record[key] !== undefined).map(key => [key, record[key]])); }
function stable(value: any): string { return JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, JSON.parse(stable(value[key]))])) : value); }
const recordIdentity = (record: any) => stable({ id: record.id, ...dnsRecordBody(record) });
const sameRecords = (a: any[], b: any[]) => stable(a.map(recordIdentity).sort()) === stable(b.map(recordIdentity).sort());
const dnsRecords = async (provider: Provider, entry: Pick<Entry, 'zone_id' | 'hostname'>) => (await provider(`/zones/${entry.zone_id}/dns_records?name=${encodeURIComponent(entry.hostname)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
const rules = (provider: Provider, zone: string) => provider(`/zones/${zone}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, { missing: true });

/** Persist the complete rollback baseline before the first traffic or rule write. */
export async function armDomainCutover(org: string, site: string, group: string, config: DomainConfiguration) {
  if (!config.candidate || config.cutover_approved_revision !== config.revision || config.dns_mode !== 'automatic') return null;
  const path = journalPath(org, site, config.candidate.id), store = getStore();
  const existing = await store.getDoc<CutoverJournal>(path);
  if (existing) {
    if (existing.revision !== config.revision || !['armed', 'live'].includes(existing.state)) throw new ConnectionError('This traffic switch has already been rolled back or needs attention.', 409, 'cutover_not_active');
    return existing;
  }
  const preparations = [config.approved_preparation, config.approved_media_preparation, ...config.approved_redirect_preparations ?? [], ...(config.approved_previous_host_preparations ?? []).flatMap(item => item.redirect ? [item.redirect] : [])].filter((item): item is DomainPreparation => Boolean(item?.zone_id));
  const entries: Entry[] = [];
  for (const preparation of preparations) {
    if (entries.some(entry => entry.hostname === preparation.hostname)) continue;
    const access = await hostingDns(org, group, preparation.hostname);
    const before = await dnsRecords(access.provider, { zone_id: preparation.zone_id!, hostname: preparation.hostname });
    if (trafficFingerprint(before) !== preparation.dns_fingerprint) throw new ConnectionError('DNS changed after approval. Review the current records before switching traffic.', 409, 'dns_revision_conflict');
    const redirect = 'rule' in preparation ? preparation as RedirectPreparation : undefined;
    entries.push({ hostname: preparation.hostname, group_id: access.groupId, account_id: access.accountId, zone_id: preparation.zone_id!, before, after: null,
      ...(redirect ? { redirect, rules_before: await rules(access.provider, preparation.zone_id!), rules_after: null } : {}) });
  }
  const journal: CutoverJournal = { revision: config.revision, candidate_id: config.candidate.id, state: 'armed',
    deadline_at: Date.now() + (config.validation_timeout_minutes ?? 15) * 60_000, entries, previous_active: config.active, previous_hosts: config.previous_hosts ?? [],
    previous_publication: (await store.getDoc<any>(`${paths.site(org, site)}/publishing_targets/main`))?.last_publication ?? null,
    previous_version: Object.fromEntries(['last_deployed_at', 'last_deployed_content_at', 'deploy_url'].map(key => [key, null])),
    previous_site: Object.fromEntries(['domain', 'domain_status', 'domain_verified_at'].map(key => [key, null])), errors: [] };
  const previousVersion = await store.getDoc<any>(paths.version(org, site, 'main')), previousSite = await store.getDoc<any>(paths.site(org, site));
  for (const key of Object.keys(journal.previous_version)) journal.previous_version[key] = previousVersion?.[key] ?? null;
  for (const key of Object.keys(journal.previous_site)) journal.previous_site[key] = previousSite?.[key] ?? null;
  await store.createDocIfMissing(path, journal);
  return (await store.getDoc<CutoverJournal>(path))!;
}

/** The unique write marker recovers a DNS change even if the provider response was lost. */
export function journaledDomainProvider(provider: Provider, org: string, site: string, candidate: string, hostname: string): Provider {
  return async (route, options) => {
    if (!options?.method || !['PATCH', 'POST'].includes(options.method)) return provider(route, options);
    const path = journalPath(org, site, candidate), store = getStore(), journal = await store.getDoc<CutoverJournal>(path);
    const entry = journal?.entries.find(item => item.hostname === hostname);
    if (!journal || journal.state !== 'armed' || journal.deadline_at <= Date.now() || !entry) throw new ConnectionError('No active traffic journal was armed.', 409, 'cutover_journal_missing');
    let body: any, patch: Partial<Entry>;
    if (route === `/zones/${entry.zone_id}/dns_records${entry.before.length ? '/' + entry.before[0].id : ''}`) {
      body = { ...options.body as object, comment: `Typeroll cutover ${candidate}` };
      const intent = { ...(entry.before[0] ? dnsRecordBody(entry.before[0]) : {}), ...body } as Record<string, any>;
      // Cloudflare drops CNAME-only settings when a redirect replaces CNAME with A.
      // Normalize only this known type transition; retain every other conflict check.
      if (entry.before[0]?.type === 'CNAME' && ['A', 'AAAA'].includes(intent.type) && intent.settings) {
        intent.settings = { ...intent.settings };
        delete intent.settings.flatten_cname;
      }
      patch = { dns_intent: intent };
    } else if (entry.redirect && route.startsWith(`/zones/${entry.zone_id}/rulesets`)) {
      const input = options.body as any, rule = input.rules?.length === 1 ? input.rules[0] : input;
      if (rule.ref !== entry.redirect.rule.ref) throw new ConnectionError('The redirect rule is outside the approved cutover.', 409, 'cutover_rule_mismatch');
      const tagged = { ...rule, description: `Typeroll cutover ${candidate}` };
      body = input.rules ? { ...input, rules: [tagged] } : tagged; patch = { rule_intent: tagged };
    } else throw new ConnectionError('This provider write is outside the approved cutover.', 409, 'cutover_write_mismatch');
    const saved = await store.compareAndReplaceDoc(path, journal, { ...journal, entries: journal.entries.map(item => item.hostname === hostname ? { ...item, ...patch } : item) });
    if (!saved) throw new ConnectionError('The traffic journal changed. Resume the same publication.', 409, 'cutover_journal_conflict');
    return provider(route, { ...options, body });
  };
}
function matchesIntent(records: any[], entry: Entry) {
  if (records.length !== 1 || !entry.dns_intent || entry.before.length && records[0].id !== entry.before[0].id) return false;
  const actual = dnsRecordBody(records[0]);
  // Provider-generated defaults are allowed; customer-supplied settings, tags and comments are not ignored.
  const normalized = (record: any) => ({ tags: [], settings: {}, ...record });
  return stable(normalized(actual)) === stable(normalized(entry.dns_intent));
}

/** Record provider-confirmed writes. A lost response leaves after=null and requires conflict-safe recovery. */
export async function recordDomainCutover(org: string, site: string, candidate: string, hostname: string) {
  const path = journalPath(org, site, candidate), store = getStore(), journal = await store.getDoc<CutoverJournal>(path);
  if (!journal || journal.state !== 'armed') return;
  const entry = journal.entries.find(item => item.hostname === hostname);
  if (!entry) return;
  const access = await hostingDns(org, entry.group_id, hostname);
  if (access.accountId !== entry.account_id) throw new ConnectionError('The DNS account changed during cutover.', 409, 'cutover_account_changed');
  const after = await dnsRecords(access.provider, entry);
  if (entry.dns_intent && !matchesIntent(after, entry) && !sameRecords(after, entry.before)) throw new ConnectionError('DNS differs from the intended cutover write.', 409, 'dns_revision_conflict');
  const updated = { ...entry, after, ...(entry.redirect ? { rules_after: await rules(access.provider, entry.zone_id) } : {}) };
  const saved = await store.compareAndReplaceDoc(path, journal, { ...journal, entries: journal.entries.map(item => item.hostname === hostname ? updated : item) });
  if (!saved) throw new ConnectionError('The traffic journal changed. Resume the same publication.', 409, 'cutover_journal_conflict');
}

export async function readDomainCutover(org: string, site: string, candidate: string) { return getStore().getDoc<CutoverJournal>(journalPath(org, site, candidate)); }
export async function completeDomainCutover(org: string, site: string, candidate: string) {
  await getStore().compareAndUpdateDoc<CutoverJournal>(journalPath(org, site, candidate), value => value.state === 'armed', { state: 'live' });
}

/** Called under the publication's existing site lease. Never overwrites a later DNS or rule edit. */
export async function rollbackDomainCutover(org: string, site: string, candidate: string) {
  const path = journalPath(org, site, candidate), store = getStore();
  const journal = await store.getDoc<CutoverJournal>(path);
  if (!journal || journal.state === 'rolled_back') return journal;
  const config = await store.getDoc<DomainConfiguration>(siteDomainConfigPath(org, site));
  const target = await store.getDoc<any>(`${paths.site(org, site)}/publishing_targets/main`);
  const lastId = target?.last_publication?.publication_id;
  if (config?.candidate?.id !== candidate || lastId && lastId !== candidate && lastId !== journal.previous_publication?.publication_id) {
    throw new ConnectionError('A newer domain candidate or publication exists. Review its traffic before restoring an older switch.', 409, 'cutover_superseded');
  }
  await store.updateDoc(path, { state: 'rolling_back' });
  const errors: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      const access = await hostingDns(org, entry.group_id, entry.hostname), provider = access.provider;
      if (access.accountId !== entry.account_id) throw new Error('The connected DNS account changed.');
      const current = await dnsRecords(provider, entry);
      if (!sameRecords(current, entry.before)) {
        // Without a confirmed after-image it is unsafe to distinguish our write from a concurrent edit.
        if (!(entry.after && sameRecords(current, entry.after)) && !matchesIntent(current, entry)) throw new Error('DNS differs from the recorded cutover. Review the saved previous records before restoring manually.');
        if (entry.before.length > 1 || current.length !== 1) throw new Error('The DNS record set changed.');
        const root = `/zones/${entry.zone_id}/dns_records`;
        if (!entry.before.length) await provider(`${root}/${current[0].id}`, { method: 'DELETE' });
        else {
          if (current[0].id !== entry.before[0].id) throw new Error('The DNS record identity changed.');
          await provider(`${root}/${current[0].id}`, { method: 'PUT', body: dnsRecordBody(entry.before[0]) });
        }
      }
      if (entry.redirect) {
        const currentRules = await rules(provider, entry.zone_id);
        const beforeRule = entry.rules_before?.rules?.find((rule: any) => rule.ref === entry.redirect!.rule.ref);
        const currentRule = currentRules?.rules?.find((rule: any) => rule.ref === entry.redirect!.rule.ref);
        const afterRule = entry.rules_after?.rules?.find((rule: any) => rule.ref === entry.redirect!.rule.ref);
        if (currentRule && !beforeRule) {
          const ruleFields = (rule: any) => Object.fromEntries(['ref', 'description', 'expression', 'action', 'enabled', 'action_parameters'].map(key => [key, rule?.[key] ?? null]));
          if (!(afterRule && stable(currentRule) === stable(afterRule)) && !(entry.rule_intent && stable(ruleFields(currentRule)) === stable(ruleFields(entry.rule_intent)))) throw new Error('The redirect rule differs from the recorded cutover.');
          await provider(`/zones/${entry.zone_id}/rulesets/${currentRules.id}/rules/${currentRule.id}`, { method: 'DELETE' });
        }
      }
    } catch (error) { errors.push(`${entry.hostname}: ${error instanceof Error ? error.message : 'Rollback could not be confirmed.'}`); }
  }
  const state = errors.length ? 'conflict' : 'rolled_back';
  await store.updateDoc(path, { state, errors });
  if (!errors.length) {
    const restored = await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(org, site), current => current.candidate?.id === candidate,
      { state: 'failed', active: journal.previous_active, previous_hosts: journal.previous_hosts ?? [], cutover_approved_revision: null, rollback_requested: false, rollback_status: 'rolled_back' });
    if (!restored) {
      await store.updateDoc(path, { state: 'conflict', errors: ['DNS restored, but site settings changed concurrently. Review publication metadata.'] });
      throw new ConnectionError('DNS restored, but site settings changed concurrently. Review publication metadata.', 409, 'cutover_metadata_conflict');
    }
    if (journal.previous_site) await store.updateDoc(paths.site(org, site), journal.previous_site);
    if (journal.previous_version) await store.updateDoc(paths.version(org, site, 'main'), journal.previous_version);
    if (target) await store.updateDoc(`${paths.site(org, site)}/publishing_targets/main`, { last_publication: journal.previous_publication ?? null });
  } else await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(org, site), current => current.candidate?.id === candidate, { rollback_status: 'conflict' });
  return { ...journal, state, errors };
}

/** Manual rollback uses the same serialized publication chain, including after success. */
export async function requestDomainRollback(org: string, site: string, config: DomainConfiguration, input: Record<string, unknown>) {
  if (input.revision !== config.revision || input.candidate_id !== config.candidate?.id || !config.candidate?.job_id) throw new ConnectionError('Read the current candidate before requesting rollback.', 409, 'domain_revision_conflict');
  const journal = await readDomainCutover(org, site, config.candidate.id);
  if (!journal) throw new ConnectionError('No automatic traffic switch was recorded. Apply external DNS rollback with your DNS administrator.', 409, 'cutover_journal_missing');
  if (journal.state === 'rolled_back') return journal;
  const target = await getStore().getDoc<any>(`${paths.site(org, site)}/publishing_targets/main`);
  if (target?.last_publication?.publication_id && target.last_publication.publication_id !== config.candidate.id && target.last_publication.publication_id !== journal.previous_publication?.publication_id) throw new ConnectionError('A newer publication exists. An older switch cannot be restored automatically.', 409, 'cutover_superseded');
  if (target?.job_id && target.job_id !== config.candidate.job_id) throw new ConnectionError('Another publication is running. Wait before requesting rollback.', 409, 'publication_in_progress');
  const updated = await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(org, site), value => value.revision === config.revision && value.candidate?.id === config.candidate!.id, { rollback_requested: true, state: 'distributing' });
  if (!updated) throw new ConnectionError('The current domain candidate changed.', 409, 'domain_revision_conflict');
  const jobPath = paths.deploy(org, site, config.candidate.job_id);
  await getStore().updateDoc(jobPath, { status: 'running', phase: 'restoring previous domain traffic', rollback_candidate_id: config.candidate.id });
  const { getDeployQueue } = await import('../deploy/queue');
  await getDeployQueue().enqueue({ orgId: org, siteId: site, jobId: config.candidate.job_id, versionId: 'main', environment: 'production', dispatchKey: randomUUID() });
  return { state: 'restoring', candidate_id: config.candidate.id };
}
