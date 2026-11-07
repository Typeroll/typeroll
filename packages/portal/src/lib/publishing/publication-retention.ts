import { paths, usesCustomerPublishing, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';

/**
 * Retention of frozen publication snapshots, run once at the end of each
 * publication for that site (never on a schedule). Only the snapshot chunks
 * are removed; the compact deploy record stays and records when its snapshot
 * was pruned. A snapshot is kept when its publication is:
 * - still running, or has an unknown status or finish time;
 * - succeeded within 30 days, or failed within 7 days;
 * - one of the latest three succeeded per version and environment;
 * - referenced by the site's publishing targets, domain state or cutovers,
 *   or by any kept publication (snapshot, base and source references are
 *   followed transitively).
 * Only sites that publish to the customer's own accounts are pruned: a hosted
 * restore makes an earlier publication's record current again.
 */

const DAY = 86_400_000;
/** Bounds the work of one run; a backlog drains over the next publications. */
export const PRUNE_LIMIT_PER_RUN = 25;
const JOB_REFERENCE_KEYS = new Set(['snapshot_job_id', 'base_job_id', 'source_job_id']);
// Site documents also name publications by their plain job id (the lease
// owner, the published and candidate domain states).
const SITE_REFERENCE_KEYS = new Set([...JOB_REFERENCE_KEYS, 'job_id']);

export interface RetentionJob {
  id: string;
  status?: string;
  version_id?: string;
  environment?: string;
  finished_at?: string | null;
  git_publication?: { snapshot_digest?: string; snapshot_chunks?: number; snapshot_format?: 1; snapshot_pruned_at?: string } | null;
  [key: string]: unknown;
}

export interface RetentionCandidate { job_id: string; snapshot_digest: string; snapshot_chunks: number; snapshot_format: 0 | 1 }

export function publicationRetentionPlan({ jobs, references = [], now = Date.now() }: { jobs: RetentionJob[]; references?: unknown[]; now?: number }) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  if (byId.size !== jobs.length || jobs.some(job => typeof job.id !== 'string' || !job.id)) throw new Error('Invalid publication inventory');
  const keep = new Map<string, Set<string>>();
  const mark = (id: string, reason: string) => {
    // A reference to a missing publication protects nothing.
    if (!byId.has(id)) return;
    const reasons = keep.get(id) ?? new Set<string>();
    reasons.add(reason);
    keep.set(id, reasons);
  };
  const inspect = (value: unknown, keys: Set<string>, reason: string): void => {
    if (Array.isArray(value)) { for (const item of value) inspect(item, keys, reason); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (keys.has(key) && typeof item === 'string') mark(item, reason);
      else inspect(item, keys, reason);
    }
  };
  for (const reference of references) inspect(reference, SITE_REFERENCE_KEYS, 'site_reference');
  const groups = new Map<string, RetentionJob[]>();
  for (const job of jobs) {
    if (job.status !== 'succeeded' && job.status !== 'failed') mark(job.id, 'active_or_unknown_status');
    if (job.status === 'succeeded') {
      const key = JSON.stringify([job.version_id ?? 'main', job.environment ?? 'production']);
      groups.set(key, [...(groups.get(key) ?? []), job]);
    }
    const finished = Date.parse(job.finished_at ?? '');
    if (!Number.isFinite(finished)) mark(job.id, 'unknown_finish_time');
    else if (now - finished < (job.status === 'failed' ? 7 : 30) * DAY) mark(job.id, 'retention_window');
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(b.finished_at ?? '') - Date.parse(a.finished_at ?? ''));
    for (const job of group.slice(0, 3)) mark(job.id, 'latest_three');
  }
  let size: number;
  do {
    size = keep.size;
    for (const id of [...keep.keys()]) inspect(byId.get(id), JOB_REFERENCE_KEYS, 'retained_publication_dependency');
  } while (keep.size !== size);
  const candidates: RetentionCandidate[] = jobs
    .filter(job => !keep.has(job.id) && job.git_publication?.snapshot_digest && !job.git_publication.snapshot_pruned_at)
    .map(job => ({ job_id: job.id, snapshot_digest: job.git_publication!.snapshot_digest!, snapshot_chunks: job.git_publication!.snapshot_chunks ?? 0,
      snapshot_format: job.git_publication!.snapshot_format === 1 ? 1 as const : 0 as const }))
    .sort((a, b) => a.job_id.localeCompare(b.job_id));
  return { candidates, retained: [...keep].map(([job_id, reasons]) => ({ job_id, reasons: [...reasons].sort() })).sort((a, b) => a.job_id.localeCompare(b.job_id)) };
}

const chunkPath = (orgId: string, siteId: string, candidate: RetentionCandidate, index: number) => {
  const deploy = paths.deploy(orgId, siteId, candidate.job_id), part = String(index).padStart(4, '0');
  return candidate.snapshot_format === 1 ? `${deploy}/snapshot_versions/${candidate.snapshot_digest}/chunks/${part}` : `${deploy}/snapshot_chunks/${part}`;
};

/** Prune the site's expired publication snapshots. Never throws: retention must not fail a publication. */
export async function pruneSitePublicationSnapshots(orgId: string, siteId: string, { now = Date.now(), limit = PRUNE_LIMIT_PER_RUN } = {}) {
  const store = getStore();
  try {
    const site = paths.site(orgId, siteId);
    const [jobs, targets, publishing, cutovers, siteDoc] = await Promise.all([
      store.listDocs<RetentionJob>(paths.deploys(orgId, siteId)),
      store.listDocs(`${site}/publishing_targets`),
      store.listDocs(`${site}/publishing`),
      store.listDocs(`${site}/domain_cutovers`),
      store.getDoc<Site>(site),
    ]);
    if (!siteDoc || !usesCustomerPublishing(siteDoc)) return { pruned: 0, remaining: 0 };
    const { candidates } = publicationRetentionPlan({ jobs, references: [targets, publishing, cutovers, siteDoc], now });
    const pruned: string[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      if (!Number.isSafeInteger(candidate.snapshot_chunks) || candidate.snapshot_chunks < 1 || candidate.snapshot_chunks > 250) continue;
      for (let index = 0; index < candidate.snapshot_chunks; index++) await store.deleteDoc(chunkPath(orgId, siteId, candidate, index));
      // Replace the whole record so every store keeps the other publication fields.
      const path = paths.deploy(orgId, siteId, candidate.job_id);
      const current = await store.getDoc<RetentionJob>(path);
      if (current?.git_publication?.snapshot_digest !== candidate.snapshot_digest || current.git_publication.snapshot_pruned_at) continue;
      const { id: _id, ...record } = current;
      await store.compareAndReplaceDoc(path, current, { ...record, git_publication: { ...current.git_publication, snapshot_pruned_at: new Date(now).toISOString() } });
      pruned.push(candidate.job_id);
    }
    if (candidates.length) {
      console.info(JSON.stringify({ event: 'publication_snapshots_pruned', org_id: orgId, site_id: siteId, pruned: pruned.length, remaining: candidates.length - pruned.length }));
    }
    return { pruned: pruned.length, remaining: candidates.length - pruned.length };
  } catch (error) {
    console.error(JSON.stringify({ event: 'publication_snapshot_prune_failed', org_id: orgId, site_id: siteId, message: (error as Error)?.message ?? 'unknown' }));
    return { pruned: 0, remaining: null };
  }
}
