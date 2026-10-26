import { auditDesignTokens, buildCoreBlockRegistry, defaultSiteSettings, type DesignTokenSource } from '@typeroll/shared';
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
  return { site_id: siteId, organization_id: orgId, version_id: versionId, scope: 'saved_content' as const,
    total: findings.length, counts: Object.fromEntries(['hardcoded_color','hardcoded_size','hardcoded_font'].map(code => [code, findings.filter(f => f.code === code).length])),
    exact_replacements: findings.flatMap(f => f.replacement ? [f.replacement] : []), findings,
    blocking: false, note: 'Saved content only; unsaved working copies are not included. Suggestions require semantic and visual review. No content was changed.' };
}
