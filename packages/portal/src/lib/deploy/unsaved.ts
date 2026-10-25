import { listWorkingCopies } from '../working-copy';

/** Do not return draft content or editor identities; only reviewable targets. */
export async function unsavedPublicationTargets(orgId: string, siteId: string, versionId: string) {
  const copies = await listWorkingCopies({ orgId, siteId, versionId });
  return copies.filter(copy => Object.keys(copy.fields ?? {}).length > 0)
    .map(copy => ({ kind: copy.kind, id: copy.target_id, updated_at: copy.updated_at }));
}
