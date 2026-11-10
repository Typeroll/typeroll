// `heading_anchor_changed` write warnings: a published heading whose generated
// id changes with its text (shared heading-anchors.ts).
//
// "Published" is what the platform already knows: the page is live
// (`published` or `unlisted`) and its version has a live deployment. The ids
// visitors have are taken from the saved page as it was before the write,
// which is what the publication serves (a draft is never deployed), so a
// `save: true` write is compared with the content it replaces.
import { headingAnchorChanges, paths, type HeadingAnchorChangedWarning, type Page, type PageBody, type SiteVersion } from '@typeroll/shared';
import { getStore } from './datastore';
import { isLivePageStatus } from './redirect-hygiene';
import { overlayWorkingCopy, readWorkingCopy } from './working-copy';

type Ctx = { orgId: string; siteId: string; versionId: string };

async function deployed(ctx: Ctx): Promise<boolean> {
  try {
    const version = await getStore().getDoc<SiteVersion>(paths.version(ctx.orgId, ctx.siteId, ctx.versionId));
    return Boolean(version?.last_deployed_at);
  } catch {
    return false;
  }
}

/** The page's draft body before a write, for comparison with the body after it. */
export async function pageDraftBody(ctx: Ctx, pageId: string, saved: Page): Promise<PageBody> {
  const draft = overlayWorkingCopy(saved, await readWorkingCopy(ctx, { kind: 'page', id: pageId }));
  return { content_mode: saved.content_mode, blocks: draft.blocks, html_content: draft.html_content };
}

/**
 * Published heading ids the write changed. `saved` is the page as stored
 * before the write, `before` and `after` the draft body around it.
 */
export async function headingAnchorWarnings(
  ctx: Ctx,
  saved: Page | null | undefined,
  before: PageBody,
  after: PageBody,
): Promise<HeadingAnchorChangedWarning[]> {
  if (!saved || !isLivePageStatus(saved.status) || !(await deployed(ctx))) return [];
  return headingAnchorChanges(saved, before, after);
}
