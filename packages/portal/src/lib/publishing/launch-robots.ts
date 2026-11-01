import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { resolvePublicationVersion } from './publication-version';
import { readSnapshot, type SnapshotReference } from './publication-snapshot';
import { siteHostingGroup } from './hosting-groups';
import { generatedCloudflareNames } from './cloudflare-account-claims';
import { ConnectionError } from './connections';
import type { DomainConfiguration } from './domain-config';

/**
 * Search-engine blocks a site author set on purpose. Typeroll's own block of a
 * temporary or version address (X-Robots-Tag and the frozen robots_blocked flag)
 * is not authored and never counts here: it ends when the site moves to its
 * real website host.
 */
export interface AuthoredRobots { noindex: boolean; nofollow: boolean; head_noindex: boolean }

export type LaunchRobotsSource = 'site_settings' | 'publication' | 'candidate';
export interface LaunchRobotsFinding { source: LaunchRobotsSource; robots: AuthoredRobots; scripts_head?: string }

const ROBOTS_META = /<meta\b[^>]*>/gi;

/** True when custom head HTML holds a robots (or googlebot) meta tag with noindex. */
export function headHasNoindex(html: unknown): boolean {
  if (typeof html !== 'string' || !html) return false;
  for (const tag of html.match(ROBOTS_META) ?? []) {
    const name = /\bname\s*=\s*["']?\s*(robots|googlebot|bingbot)\b/i.test(tag);
    if (name && /\bcontent\s*=\s*["'][^"']*\bnoindex\b/i.test(tag)) return true;
  }
  return false;
}

/**
 * Authored robots blocks in a settings object. For a frozen publication pass its
 * `authored_noindex`: its `settings.sitewide_noindex` also carries the platform's
 * temporary-address block, so that flag alone cannot tell the two apart.
 */
export function authoredRobots(settings: Record<string, unknown> | null | undefined, authoredNoindex?: boolean): AuthoredRobots {
  return {
    noindex: authoredNoindex ?? settings?.sitewide_noindex === true,
    nofollow: settings?.sitewide_nofollow === true,
    head_noindex: headHasNoindex(settings?.scripts_head),
  };
}

const ROBOTS_NAME = /\bname\s*=\s*["']?\s*(robots|googlebot|bingbot)\b/i;
const CONTENT = /(\bcontent\s*=\s*)(["'])([^"']*)\2/i;

/**
 * Remove `noindex` and `nofollow` from robots meta tags in custom head HTML, keeping
 * other directives (`noarchive`, ...). A tag left without directives is removed.
 * Returns null when the result would still contain a robots noindex, so a caller
 * never claims to have made the site indexable when it has not.
 */
export function stripRobotsNoindex(html: string): string | null {
  const stripped = html.replace(ROBOTS_META, tag => {
    if (!ROBOTS_NAME.test(tag)) return tag;
    const content = tag.match(CONTENT);
    if (!content) return tag;
    const directives = content[3].split(',').map(item => item.trim()).filter(Boolean);
    const kept = directives.filter(item => !/^(noindex|nofollow)$/i.test(item));
    if (kept.length === directives.length) return tag;
    return kept.length ? tag.replace(CONTENT, (_m, prefix, quote) => `${prefix}${quote}${kept.join(', ')}${quote}`) : '';
  });
  return headHasNoindex(stripped) ? null : stripped;
}

/** Settings with authored noindex/nofollow turned off; null when scripts_head cannot be cleaned precisely. */
export function indexableSettings<T extends Record<string, unknown>>(settings: T): T | null {
  const next: Record<string, unknown> = { ...settings, sitewide_noindex: false, sitewide_nofollow: false };
  if (typeof settings.scripts_head === 'string' && headHasNoindex(settings.scripts_head)) {
    const head = stripRobotsNoindex(settings.scripts_head);
    if (head === null) return null;
    next.scripts_head = head;
  }
  return next as T;
}

export const blocksLaunch = (robots: AuthoredRobots) => robots.noindex || robots.nofollow || robots.head_noindex;

/** Whether the saved website host is a real address rather than the generated temporary one. */
async function realWebsiteHost(orgId: string, siteId: string, config: DomainConfiguration) {
  const host = config.desired.website_host;
  if (!host) return false;
  const group = await siteHostingGroup(orgId, siteId).catch(() => null);
  const label = generatedCloudflareNames(orgId, siteId).site_label;
  return !(group?.sites_domain && host.toLowerCase() === `${label}.${group.sites_domain}`.toLowerCase());
}

type PublicationReference = Partial<SnapshotReference> & { publication_id?: string; snapshot_job_id?: string };

async function publicationRobots(orgId: string, siteId: string, publication: PublicationReference | null | undefined) {
  if (!publication?.snapshot_job_id || !publication.snapshot_digest || !publication.snapshot_chunks) return null;
  try {
    const frozen = await readSnapshot({ orgId, siteId, jobId: publication.snapshot_job_id }, publication as SnapshotReference);
    // Older snapshots have no authored_noindex; then a main publication outside the
    // platform's own block carries only authored noindex in its settings.
    const authored = typeof frozen?.authored_noindex === 'boolean' ? frozen.authored_noindex
      : frozen?.robots_blocked === true ? undefined : frozen?.settings?.sitewide_noindex === true;
    const robots = authoredRobots(frozen?.settings ?? {}, authored ?? false);
    return { robots, scripts_head: typeof frozen?.settings?.scripts_head === 'string' ? frozen.settings.scripts_head as string : undefined };
  } catch { return null; }
}

/**
 * Authored noindex/nofollow that would hide the site on its new website host:
 * in current site settings (the next publication), in the last main publication
 * (what prepare republishes) and in the prepared candidate. Empty when no real
 * website host is saved.
 */
export async function launchRobotsFindings(orgId: string, siteId: string, config: DomainConfiguration, options: { settings?: Record<string, unknown> | null } = {}): Promise<LaunchRobotsFinding[]> {
  if (!await realWebsiteHost(orgId, siteId, config)) return [];
  const findings: LaunchRobotsFinding[] = [];
  let settings = options.settings;
  if (settings === undefined) settings = await resolvePublicationVersion(orgId, siteId, 'main').then(value => value.settings ?? {}, () => null);
  if (settings) {
    const robots = authoredRobots(settings);
    if (blocksLaunch(robots)) findings.push({ source: 'site_settings', robots, ...robots.head_noindex ? { scripts_head: String(settings.scripts_head) } : {} });
  }
  const target = await getStore().getDoc<{ last_publication?: PublicationReference }>(`${paths.site(orgId, siteId)}/publishing_targets/main`).catch(() => null);
  // A preparation that is already clearing authored noindex replaces the last publication and the candidate.
  const clearing = (await getStore().listDocs<{ status?: string; clear_authored_noindex?: boolean; source_publication?: { publication_id?: string } }>(paths.deploys(orgId, siteId)).catch(() => []))
    .some(job => job.clear_authored_noindex === true && ['queued', 'running'].includes(String(job.status)) && job.source_publication?.publication_id === target?.last_publication?.publication_id);
  if (clearing) return findings;
  const published = await publicationRobots(orgId, siteId, target?.last_publication);
  if (published && blocksLaunch(published.robots)) findings.push({ source: 'publication', robots: published.robots, ...published.robots.head_noindex ? { scripts_head: published.scripts_head } : {} });
  const candidate = config.candidate;
  if (candidate?.sitewide_noindex === true && candidate.robots_blocked !== true && !findings.some(item => item.source === 'publication' && item.robots.noindex)) {
    findings.push({ source: 'candidate', robots: { noindex: true, nofollow: false, head_noindex: false } });
  }
  return findings;
}

/**
 * Whether the person preparing this launch chose to keep the site hidden (allow_noindex_launch).
 * The choice is stored on the preparation job, so the check and the approval honour it.
 */
export async function hiddenLaunchAccepted(orgId: string, siteId: string, config: DomainConfiguration) {
  const jobs = await getStore().listDocs<{ id?: string; status?: string; allow_noindex_launch?: boolean; publication_intent?: string }>(paths.deploys(orgId, siteId)).catch(() => []);
  return jobs.some(job => job.allow_noindex_launch === true && job.publication_intent === 'domain_prepare' &&
    (job.id === config.candidate?.job_id || ['queued', 'running'].includes(String(job.status))));
}

const describe = (robots: AuthoredRobots) => [robots.noindex && 'sitewide_noindex', robots.nofollow && 'sitewide_nofollow', robots.head_noindex && 'a robots noindex meta tag in scripts_head'].filter(Boolean).join(', ');
const SOURCE_LABEL: Record<LaunchRobotsSource, string> = { site_settings: 'site settings', publication: 'the last published site', candidate: 'the prepared publication' };

export function launchRobotsMessage(findings: LaunchRobotsFinding[]) {
  const where = findings.map(item => `${SOURCE_LABEL[item.source]} (${describe(item.robots)})`).join('; ');
  return `Search engines are told not to index or follow this site: ${where}. Launching on the new website host would keep it hidden from search. ` +
    'The temporary address is already blocked from indexing by Typeroll, so this setting is not needed during migration. ' +
    'Prepare with confirm_disable_noindex: true to turn it off and publish indexable for the new domain in one step, or turn it off in Site settings and publish first. To launch hidden on purpose, pass allow_noindex_launch: true.';
}

/**
 * Reject prepare or approve while an authored block would hide the launched site, unless explicitly
 * allowed. With `disable` (prepare only) and `confirm_disable_noindex`, return the findings to clear.
 */
export async function assertIndexableLaunch(orgId: string, siteId: string, config: DomainConfiguration, input: Record<string, unknown>, options: { disable?: boolean } = {}) {
  if (input?.allow_noindex_launch === true) return [];
  if (!options.disable && await hiddenLaunchAccepted(orgId, siteId, config)) return [];
  const findings = await launchRobotsFindings(orgId, siteId, config);
  if (!findings.length) return findings;
  // Only prepare can turn noindex off: it rebuilds the candidate. Approval switches an existing build.
  if (!options.disable || input?.confirm_disable_noindex !== true) throw new ConnectionError(launchRobotsMessage(findings), 409, 'candidate_noindex');
  // A robots tag we cannot remove precisely is left to the user rather than half-removed.
  if (findings.some(item => item.robots.head_noindex && (item.scripts_head === undefined || stripRobotsNoindex(item.scripts_head) === null))) {
    throw new ConnectionError('scripts_head contains a robots noindex tag that Typeroll cannot remove precisely. Remove it in Site settings, publish, then prepare the domain change.', 409, 'candidate_noindex_head');
  }
  return findings;
}
