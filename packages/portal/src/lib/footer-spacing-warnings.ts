import { applyRouteOverridesToTree, routeKind, composePageWithTemplate, footerSpacingWarnings, type Block, type Page, type FooterSpacingWarning } from '@typeroll/shared';
import { vstore } from './version-store';

/** Only layout edits need the template/settings reads. A field-only save keeps
 * its fast path. No render, media preparation or cross-page query runs here. */
export async function pageFooterSpacingWarnings(
  ctx: { orgId: string; siteId: string; versionId: string }, page: Page,
  changed: Record<string, unknown>, templateId?: string,
): Promise<FooterSpacingWarning[]> {
  if (page.content_mode !== 'blocks' || page.footer_spacing === 'none' || !['blocks', 'template', 'footer_spacing'].some(key => key in changed)) return [];
  const [settings, template] = await Promise.all([
    vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId),
    (page.template || templateId) ? vstore.pageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, (page.template || templateId)!) : null,
  ]);
  const body = template?.blocks?.length ? composePageWithTemplate(template.blocks, page.blocks ?? []) : page.blocks ?? [];
  // Expand only referenced globals, once each, with a cycle/depth guard.
  const globals = new Map<string, Block[]>();
  async function expand(blocks: Block[], stack: string[] = []): Promise<Block[]> {
    const out: Block[] = [];
    for (const block of blocks) {
      const id = block.type === 'core/global_block' ? block.data?.global_block_id : null;
      if (typeof id === 'string' && stack.length < 8 && !stack.includes(id)) {
        if (!globals.has(id)) globals.set(id, (await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, id))?.blocks ?? []);
        const expanded = await expand(globals.get(id)!, [...stack, id]);
        out.push(...expanded.map(child => ({ ...child, hidden_on: [...new Set([...(child.hidden_on ?? []), ...(block.hidden_on ?? [])])] })));
      } else out.push({ ...block, ...(block.children ? { children: await expand(block.children, stack) } : {}) });
    }
    return out;
  }
  const route = routeKind({ page: { ...page, path: page.path ?? (page.slug ? `/${page.slug}/` : '/') } });
  return footerSpacingWarnings(applyRouteOverridesToTree(await expand(body), route), page, settings?.styles, settings?.footer_min_spacing);
}
