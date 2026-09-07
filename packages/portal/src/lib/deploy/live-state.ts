import { MAIN_VERSION_ID } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

/** Only successful live uploads call this; a main staging upload cannot
 * advance production state. The cutoff precedes materialization so content
 * changed during a build never acquires a premature live link. */
export function liveDeploymentUpdate(args: {
  versionId: string;
  environment: 'production' | 'staging';
  contentCutoff: string;
  completedAt: string;
  deployUrl?: string;
}): Partial<SiteVersion> | null {
  if (args.versionId === MAIN_VERSION_ID && args.environment !== 'production') return null;
  return {
    last_deployed_at: args.completedAt,
    last_deployed_content_at: args.contentCutoff,
    ...(args.versionId !== MAIN_VERSION_ID && args.deployUrl ? { deploy_url: args.deployUrl } : {}),
  };
}
