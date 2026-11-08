import { auditDesignTokens, buildCoreBlockRegistry, defaultSiteSettings, lintSiteCss, type BlockTemplate, type DesignTokenFinding, type DesignTokenSource } from '@typeroll/shared';
import { vstore } from './version-store';
import { listBlockTemplates } from './block-templates-store';

export async function readDesignTokenAudit(orgId: string, siteId: string, versionId: string) {
  const [settings, pages, partials, templates, types, blockTemplates] = await Promise.all([
    vstore.settings(orgId, siteId, versionId), vstore.pages(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId), vstore.pageTemplates(orgId, siteId, versionId),
    vstore.blockTypes(orgId, siteId, versionId), listBlockTemplates({ orgId, siteId }),
  ]);
  const registry = buildCoreBlockRegistry();
  for (const type of types) registry.set(type.id, type);
  const sources: DesignTokenSource[] = [
    ...pages.map(page => ({ kind: 'page' as const, id: page.id, blocks: page.blocks, css: page.custom_css, html: page.html_content })),
    ...partials.map(partial => ({ kind: 'partial' as const, id: partial.id, blocks: partial.blocks, html: partial.html_content })),
    ...templates.map(template => ({ kind: 'template' as const, id: template.id, blocks: template.blocks })),
    ...types.filter(type => type.origin !== 'core').map(type => ({ kind: 'block_type' as const, id: type.id, blocks: type.composition, schema: type.schema, css: type.styles, html: type.template })),
    // Block templates (site library) follow the site they are inserted into only with tokens and roles.
    ...blockTemplates.map(template => ({ kind: 'block_template' as const, id: template.id, blocks: template.blocks })),
  ];
  const findings = auditDesignTokens(settings ?? defaultSiteSettings, sources, registry);
  // Custom CSS that works against the theme: !important, foreign fonts,
  // duplicate font loads, first-section background images, block-class rules.
  const cssFindings = lintSiteCss(settings ?? defaultSiteSettings, [
    ...pages.map(page => ({ kind: 'page' as const, id: page.id, css: page.custom_css, blocks: page.blocks })),
    ...partials.map(partial => ({ kind: 'partial' as const, id: partial.id, blocks: partial.blocks })),
    ...templates.map(template => ({ kind: 'template' as const, id: template.id, blocks: template.blocks })),
    ...types.filter(type => type.origin !== 'core').map(type => ({ kind: 'block_type' as const, id: type.id, css: type.styles })),
  ]);
  return { site_id: siteId, organization_id: orgId, version_id: versionId, scope: 'saved_content' as const,
    total: findings.length, counts: Object.fromEntries(['hardcoded_color','hardcoded_size','hardcoded_font'].map(code => [code, findings.filter(f => f.code === code).length])),
    exact_replacements: findings.flatMap(f => f.replacement ? [f.replacement] : []), findings,
    css_findings: cssFindings,
    css_counts: Object.fromEntries(['css_important_overuse','css_font_not_in_theme','css_first_section_background_image','css_block_class_override','css_duplicate_font_load'].map(code => [code, cssFindings.filter(f => f.code === code).length])),
    blocking: false, note: 'Saved content only; unsaved working copies are not included. Suggestions require semantic and visual review. No content was changed.' };
}

/**
 * Hard-coded colours and font families in one block template, with the
 * palette role or font role to use instead (`suggestions`; `replacement`
 * when one role matches exactly). Reported when a template is saved, so it
 * follows the design of the site it is inserted into; never blocking.
 */
export type TemplateDesignFinding = Pick<DesignTokenFinding, 'code' | 'path' | 'value' | 'suggestions' | 'exact_matches' | 'message' | 'block_id' | 'replacement'>;

export async function blockTemplateDesignFindings(ctx: { orgId: string; siteId: string; versionId: string }, template: Pick<BlockTemplate, 'id' | 'blocks'>): Promise<TemplateDesignFinding[]> {
  return (await templatesDesignFindings(ctx, [template])).map(({ template_id: _id, ...finding }) => finding);
}

/** The same for several templates (a package export), each finding naming its `template_id`. */
export async function templatesDesignFindings(ctx: { orgId: string; siteId: string; versionId: string }, templates: ReadonlyArray<Pick<BlockTemplate, 'id' | 'blocks'>>): Promise<Array<TemplateDesignFinding & { template_id: string }>> {
  if (!templates.length) return [];
  const [settings, types] = await Promise.all([vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId), vstore.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)]);
  const registry = buildCoreBlockRegistry();
  for (const type of types) registry.set(type.id, type);
  // Only the templates' own content: the site's settings, styles and CSS are reported by lint_design_tokens.
  const site = { ...(settings ?? defaultSiteSettings), custom_css: undefined, styles: [] };
  return auditDesignTokens(site, templates.map(template => ({ kind: 'block_template' as const, id: template.id, blocks: template.blocks })), registry)
    .filter(finding => finding.source.startsWith('block_template:') && (finding.code === 'hardcoded_color' || finding.code === 'hardcoded_font'))
    .map(({ code, source, path, value, suggestions, exact_matches, message, block_id, replacement }) => ({
      template_id: source.slice('block_template:'.length), code, path, value, suggestions, exact_matches, message,
      ...(block_id ? { block_id } : {}), ...(replacement ? { replacement } : {}),
    }));
}
