import { paths, type DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { buildActivity } from '../builds/activity';
import { unsavedPublicationTargets } from '../deploy/unsaved';
import { publicationBuildOutlook } from './build-outlook';
import { previewPublicationImpact } from './impact-preview';
import { publicationTargets } from './publication-targets';

/** How many earlier publications of the site a time estimate is based on. */
const ESTIMATE_SAMPLE = 5;

export interface PublicationPlanStep { code: string; message: string; tool?: string }

/** Median minutes of the site's last successful publications, or null without history. */
async function typicalDuration(orgId: string, siteId: string, versionId: string) {
  const jobs = await getStore().listDocs<DeployJob>(paths.deploys(orgId, siteId), { filters: [{ field: 'status', op: '==', value: 'succeeded' }], limit: 50 });
  const minutes = jobs.filter(job => !job.dry_run && job.version_id === versionId && job.started_at && job.finished_at)
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at))).slice(0, ESTIMATE_SAMPLE)
    .map(job => (Date.parse(job.finished_at!) - Date.parse(job.started_at)) / 60_000).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!minutes.length) return null;
  const middle = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[middle]! : (minutes[middle - 1]! + minutes[middle]!) / 2;
  return { typical_minutes: Math.max(1, Math.round(median)), based_on_publications: minutes.length };
}

/**
 * One read-only answer before publishing: what the publication contains (the
 * impact comparison), what stops it now (`blockers`), what only slows it
 * (`notes`), what else the organization is building, how long it usually
 * takes, and the steps left in order. It changes nothing: starting an engine
 * update or the publication stays a separate, explicit call.
 */
export async function publicationPlan(orgId: string, siteId: string, versionId: string) {
  const [targets, outlook, unsaved, activity, duration, impact] = await Promise.all([
    publicationTargets(orgId, siteId, versionId), publicationBuildOutlook(orgId, siteId, versionId), unsavedPublicationTargets(orgId, siteId, versionId),
    buildActivity(orgId), typicalDuration(orgId, siteId, versionId),
    previewPublicationImpact(orgId, siteId, versionId).then(value => ({ ok: true as const, value }), () => ({ ok: false as const })),
  ]);
  const ownJob = activity.active_jobs.find(job => job.site_id === siteId && job.kind === 'publication');
  const otherBuilds = activity.active_jobs.filter(job => job !== ownJob);
  const blockers = [...outlook.blockers.map(({ code, message }) => ({ code, message }))];
  if (!impact.ok) blockers.push({ code: 'content_comparison_failed', message: 'Saved content could not be compared with the verified publication. Check content and template validity before publishing.' });
  if (ownJob) blockers.push({ code: 'publication_running', message: `This site is already being published (job ${ownJob.job_id}). Wait for it to finish.` });
  const notes = [...outlook.notes];
  if (otherBuilds.length) notes.push({ code: 'other_builds_running', message: `${otherBuilds.length} other build${otherBuilds.length === 1 ? '' : 's'} in this organization run first.` });
  if (impact.ok && impact.value.classification === 'site_wide') notes.push({ code: 'site_wide_build', message: 'Every page is built again, not only the edited ones.' });

  const steps: PublicationPlanStep[] = [];
  if (unsaved.length) steps.push({ code: 'unsaved_content', message: `${unsaved.length} page${unsaved.length === 1 ? ' or shared block has' : 's or shared blocks have'} unsaved edits: save or discard them, or publish the saved content only (allow_unsaved: true).` });
  for (const blocker of outlook.blockers) {
    steps.push(blocker.code === 'build_engine_update_required'
      ? { code: blocker.code, message: 'An organization admin updates the build engine and waits for its verification.', tool: 'setup_organization_build_engine' }
      : { code: blocker.code, message: blocker.message });
  }
  if (impact.ok && impact.value.changes.some(change => change.kind === 'configuration')) {
    steps.push({ code: 'review_configuration', message: 'Review the configuration changes and who made them (impact.changes[].details and changed_by) with the site owner.', tool: 'get_publication_impact' });
  }
  if (targets.production) steps.push({ code: 'confirm_live_domains', message: `The publication replaces the live site at ${targets.live_domains.join(', ')}: get the owner's approval and send confirm_live_domains: true.` });
  steps.push({ code: 'publish', message: 'Start the publication and follow it until it leaves queued/running.', tool: 'trigger_deploy' });

  const verdict = blockers.length ? 'blocked' : notes.length || unsaved.length ? 'ready_with_notes' : 'ready';
  return {
    version_id: versionId, verdict, ...targets, blockers, notes, steps,
    unsaved: unsaved.length,
    builds_ahead: otherBuilds.map(job => ({ job_id: job.job_id, site_id: job.site_id, kind: job.kind, status: job.status })),
    estimate: duration ? { ...duration, longer_because: notes.filter(note => ['build_engine_update_first', 'build_engine_update_running', 'media_preparation_running', 'media_preparation_stopped', 'other_builds_running'].includes(note.code)).map(note => note.code) } : null,
    build_engine: outlook.build_engine,
    impact: impact.ok ? impact.value : null,
  };
}
