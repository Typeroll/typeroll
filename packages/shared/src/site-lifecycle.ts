import type { Site } from './types.js';

/**
 * Site retirement, shared by the portal, the build and the operator so all
 * three agree on what "archived" means.
 *
 * The predicate reads the field rather than comparing to a literal `'active'`
 * because absence is the active state — see `Site.lifecycle`. Anything that
 * grows a second status later still answers this question the same way.
 */
export function isArchivedSite(site: Pick<Site, 'lifecycle'> | null | undefined): boolean {
  return site?.lifecycle?.status === 'archived';
}

/**
 * The refusal text shown when an archived site is asked to change or publish.
 * One string, so the portal API, the deploy path and the operator do not
 * drift into three different explanations of the same state.
 */
export const ARCHIVED_SITE_MESSAGE =
  'This site is archived. Restore it before making changes or publishing.';
