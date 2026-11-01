import { auditDesignTokens, buildCoreBlockRegistry, defaultSiteSettings, lintSiteCss, type DesignTokenSource } from '@typeroll/shared';
import { vstore } from './version-store';

export async function readDesignTokenAudit(orgId: string, siteId: string, versionId: string) {
  const [settings, pages, partials, templates, types] = await Promise.all([
    vstore.settings(orgId, siteId, versionId), vstore.pages(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId), vstore.pageTemplates(orgId, siteId, versionId),
    vstore.blockTypes(orgId, siteId, versionId),
  ]);
  const registry = buildCoreBlockRegistry();
  for (const type of types) registry.set(type.id, type);
  const sources: DesignTokenSource[] = [
    ...pages.map(page => ({ kind: 'page' as const, id: page.id, blocks: page.blocks, css: page.custom_css, html: page.html_content })),
    ...partials.map(partial => ({ kind: 'partial' as const, id: partial.id, blocks: partial.blocks, html: partial.html_content })),
    ...templates.map(template => ({ kind: 'template' as const, id: template.id, blocks: template.blocks })),
    ...types.filter(type => type.origin !== 'core').map(type => ({ kind: 'block_type' as const, id: type.id, blocks: type.composition, schema: type.schema, css: type.styles, html: type.template })),
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
