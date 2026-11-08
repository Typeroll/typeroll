// Pure helpers for showing block templates in the Global blocks page and in
// the editor's block library: kind, category grouping and where an imported
// template came from.

import type { BlockTemplate } from '@typeroll/shared';

type TemplateLike = Pick<BlockTemplate, 'name' | 'kind' | 'category' | 'imported_from'>;

/** "Section" or "Block"; nothing for templates saved before kinds existed. */
export function templateKindLabel(template: Pick<BlockTemplate, 'kind'>): string | null {
  return template.kind === 'section' ? 'Section' : template.kind === 'block' ? 'Block' : null;
}

/** "From Acme Sections 1.2.0" for a template imported from a package. */
export function importedFromLabel(template: Pick<BlockTemplate, 'imported_from'>): string | null {
  const from = template.imported_from;
  if (!from?.package_name) return null;
  return `From ${from.package_name}${from.version ? ` ${from.version}` : ''}`;
}

/** Templates grouped by category (alphabetical), uncategorized last; one unnamed group when none has a category. */
export function groupBlockTemplates<T extends TemplateLike>(templates: readonly T[]): Array<{ category: string | null; templates: T[] }> {
  const groups = new Map<string | null, T[]>();
  for (const template of templates) {
    const key = template.category?.trim() || null;
    groups.set(key, [...groups.get(key) ?? [], template]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([category, list]) => ({ category, templates: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
}
