// Where a publication lands, and whether that is the live website.
//
// During a migration agents publish freely to the temporary, noindexed
// site-*.sites.<domain> address. After cutover the same main publication also
// serves the live custom domain, so a "temporary" deploy is a production
// release. Every deploy entry point reports these targets, and a real deploy
// of a cut-over site requires an explicit acknowledgement naming them.

import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { DeployEnvironment, Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { publicUrlsFor } from '../site-public-urls';
import { generatedCloudflareNames } from './cloudflare-account-claims';
import { getSiteDomains } from './domain-config';
import { siteHostingGroup } from './hosting-groups';
import { digest } from './providers.mjs';

export const LIVE_DOMAIN_CONFIRMATION_CODE = 'live_domain_confirmation_required';

export interface PublicationTargets {
  /** True when a real deploy of this version replaces what visitors see on a live custom domain. */
  production: boolean;
  /** Live custom-domain URLs the publication serves. Empty unless production. */
  live_domains: string[];
  /** Every public URL the publication serves: live domains first, then the temporary address. */
  targets: string[];
}

const url = (host: string) => `https://${host.toLowerCase()}`;

function result(live: string[], temporary: (string | null)[], production: boolean): PublicationTargets {
  const live_domains = production ? [...new Set(live)] : [];
  return { production, live_domains, targets: [...new Set([...live_domains, ...temporary.filter((value): value is string => !!value)])] };
}

/**
 * The public URLs a deploy of `versionId` reaches. A site counts as cut over
 * when its main publication serves a website host other than its generated
 * temporary address: the active host of the site's domain configuration (set
 * when a publication goes live), the website host of a migrated managed
 * project, or a live `site.domain`. Branch and staging publications never
 * reach the live domain.
 */
export async function publicationTargets(orgId: string, siteId: string, versionId: string = MAIN_VERSION_ID,
  environment: DeployEnvironment = 'production'): Promise<PublicationTargets> {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (!site) return { production: false, live_domains: [], targets: [] };
  const main = versionId === MAIN_VERSION_ID;

  if (site.publishing_mode !== 'customer_git') {
    const urls = publicUrlsFor({ ...site, id: siteId });
    if (environment === 'staging') return result([], [urls.staging], false);
    if (!main) return result([], [], false);
    return result(urls.production ? [urls.production] : [], [urls.fallback], Boolean(urls.production));
  }

  const label = generatedCloudflareNames(orgId, siteId).site_label!;
  const group = await siteHostingGroup(orgId, siteId).catch(() => null);
  const temporaryHost = group?.sites_domain ? `${main ? '' : `v-${digest(versionId).slice(0, 8)}-`}${label}.${group.sites_domain}` : null;
  const temporary = temporaryHost ? url(temporaryHost) : null;
  if (!main) return result([], [temporary], false);

  const domains = await getSiteDomains(orgId, siteId).catch(() => null);
  const liveHost = domains?.active?.website_host
    ?? site.publishing_migration?.website_host
    ?? (site.domain_status === 'live' ? site.domain ?? null : null);
  // Any generated site-<label>.<sites domain> host is temporary, also under an older address base.
  const isLive = Boolean(liveHost) && !liveHost!.toLowerCase().startsWith(`${label}.`);
  return result(isLive ? [url(liveHost!)] : [], [temporary], isLive && environment === 'production');
}

/** The refusal for a real deploy of a cut-over site without confirm_live_domains: true. */
export function liveDomainConfirmationError(targets: PublicationTargets) {
  const live = targets.live_domains.join(', ');
  const others = targets.targets.filter(target => !targets.live_domains.includes(target));
  return {
    code: LIVE_DOMAIN_CONFIRMATION_CODE,
    error: `This site is live at ${live}. Deploying publishes the saved content to ${live}${others.length ? ` and ${others.join(', ')}` : ''} immediately: ` +
      'publishing to the temporary address ended at cutover. Get the site owner’s approval for this production release, then repeat the call with confirm_live_domains: true. ' +
      'To review changes without publishing, use get_preview_link with include_working_copy, or deploy with dry_run: true.',
    requires_confirmation: true,
    ...targets,
  };
}

/** Null when the deploy may proceed; otherwise the 409 body to return. */
export function requireLiveDomainConfirmation(targets: PublicationTargets, input: { dry_run?: unknown; confirm_live_domains?: unknown }) {
  if (!targets.production || input.dry_run === true || input.confirm_live_domains === true) return null;
  return liveDomainConfirmationError(targets);
}
