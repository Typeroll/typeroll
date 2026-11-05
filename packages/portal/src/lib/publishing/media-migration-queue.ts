import { paths } from '@typeroll/shared';
import { requestChain, runChainDelivery, type Enqueue } from '../scheduling/chain';
import { putScheduledWork } from '../scheduling/index';
import { executeMediaMigration } from './media-migration';

/** One delivery chain per Organization (preparation) or per Site (migration). */
export const mediaChainKey = (orgId: string, siteId?: string) => siteId ? `media:${orgId}:${siteId}` : `media:${orgId}`;
/** The chain's pending delivery is scheduled work of its Organization or Site, in that store object. */
export const mediaChainSource = (orgId: string, siteId?: string) => siteId ? paths.site(orgId, siteId) : `organizations/${orgId}`;

/** Ask for media work; joins the existing chain for the same Organization or Site. */
/** Without a Site, runs Organization media work and pending preparation; with one, that Site's migration only. */
export async function enqueueMediaMigration(orgId: string, delayMs = 0, siteId?: string): Promise<void> {
  await requestChain(mediaChainKey(orgId, siteId), delayMs, transport(orgId, siteId));
}

/** One delivery: runs the work, then schedules the chain's next delivery if needed. */
export async function deliverMediaMigration(orgId: string, siteId: string | undefined, generation: number): Promise<'ran' | 'superseded'> {
  return runChainDelivery(mediaChainKey(orgId, siteId), generation, () => executeMediaMigration(orgId, siteId), transport(orgId, siteId));
}

/** The chain generation is the work generation, so a stale delivery is dropped by the chain record. */
function transport(orgId: string, siteId: string | undefined): Enqueue {
  return async (generation, delayMs) => {
    await putScheduledWork({
      kind: 'media_chain', source: mediaChainSource(orgId, siteId), due_at: Date.now() + Math.max(0, delayMs),
      generation: String(generation), payload: { org_id: orgId, site_id: siteId ?? null },
    });
  };
}
