import type { DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { probePublication } from '../deploy/availability';

/** A bounded observation in this publication, not a recurring website monitor. */
export async function observePublicationServing(path: string, publication: { website_host: string; publication_id: string }, verified = false) {
  let serving: DeployJob['serving'];
  await probePublication(`https://${publication.website_host}`, '/.well-known/typeroll/publication.json', publication.publication_id, { observe: async result => {
    serving = { state: result.ready ? verified ? 'verified' : 'live_unverified' : result.observed_publication ? 'different_publication' : 'unavailable',
      url: `https://${publication.website_host}`, publication_id: publication.publication_id,
      observed_publication: result.observed_publication ?? null, checked_at: result.checked_at };
    await getStore().updateDoc(path, { serving, public_probe: result });
  } });
  return serving;
}
