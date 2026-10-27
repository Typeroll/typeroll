import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from './connections';
import { getSiteDomains, parsePublicationHosts, samePublicationHosts, sameRedirectHosts } from './domain-config';

/** Preview uses the same parser and revision as save; it never changes a candidate or DNS. */
export async function domainChangeImpact(orgId: string, siteId: string, input: Record<string, unknown>) {
  const current = await getSiteDomains(orgId, siteId);
  if (input.revision !== current.revision) throw new ConnectionError('Domain settings changed. Reload before reviewing the change.', 409, 'domain_revision_conflict');
  const desired = parsePublicationHosts(input);
  const outputChanged = !samePublicationHosts(current.desired, desired);
  const changed = outputChanged || !sameRedirectHosts(current.desired, desired) || current.dns_mode !== input.dns_mode;
  const durations = outputChanged ? (await getStore().listDocs<any>(paths.deploys(orgId, siteId)))
    .filter(job => job.publication_intent === 'domain_prepare' && job.status === 'succeeded')
    .map(job => ({ time: Date.parse(job.finished_at), duration: Date.parse(job.git_publication?.candidate_prepared_at ?? '') - Date.parse(job.started_at) }))
    .filter(item => Number.isFinite(item.duration) && item.duration > 0)
    .sort((a, b) => b.time - a.time).slice(0, 5).map(item => item.duration).sort((a, b) => a - b) : [];
  const estimate = durations.length ? Math.round(durations[Math.floor(durations.length / 2)] / 1000) : null;
  return { revision: current.revision, changed, requires_candidate: outputChanged,
    candidate_preserved: Boolean(current.candidate && !outputChanged),
    confirmation_required: false,
    estimate_seconds: estimate, estimate_samples: durations.length,
    message: !changed ? 'No settings have changed.' : outputChanged
      ? `Saving these addresses does not change the deployed site. Choose Publish for the new domain to apply them to main. ${estimate == null ? 'There are not enough completed preparations to estimate the duration.' : `Recent preparations took about ${Math.ceil(estimate / 60)} minutes.`} That publication replaces the site at its current address before DNS is switched.`
      : 'The main publication is retained. DNS and redirect checks must be refreshed and traffic approval renewed; no content rebuild is required.' };
}
