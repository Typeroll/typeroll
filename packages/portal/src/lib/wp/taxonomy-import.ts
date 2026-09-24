import type { Block, ContentType, FieldDefinition, Page } from '@typeroll/shared';
import type { WPItem, WPTaxonomy, WPTerm } from './client';
import { inferContentType, projectItemFields } from './custom-types';
import { normalizeWordPressPlainText } from './plain-text';
import { pathFromUrl } from './url-inventory';

export interface TaxonomySource { taxonomy: WPTaxonomy; terms: WPTerm[] }
export interface TaxonomyImportPlan {
  contentTypes: Array<Omit<ContentType, 'id'>>;
  pages: Array<Page & { id: string }>;
  fieldsFor(sourceType: string): FieldDefinition[];
  valuesFor(item: WPItem, sourceType: string): Record<string, string[]>;
  parentFor(item: WPItem, sourceType: string): string | undefined;
}

export const taxonomyTypeName = (slug: string): string => `wp_taxonomy_${slug.replace(/-/g, '_')}`;
export const taxonomyPageId = (slug: string, id: number): string => `wp-term-${slug}-${id}`;

/** Build and validate the complete shared-term graph before writing any of it. */
export function planTaxonomyImport(sources: TaxonomySource[], origin: string, now: string): TaxonomyImportPlan {
  const contentTypes: TaxonomyImportPlan['contentTypes'] = [];
  const pages: TaxonomyImportPlan['pages'] = [];
  const names = new Set<string>();
  const byTaxonomy = new Map<string, Map<number, WPTerm>>();
  for (const { taxonomy, terms } of sources) {
    if (!/^[a-z0-9_-]+$/i.test(taxonomy.slug)) throw new Error(`Unsupported taxonomy identifier: ${taxonomy.slug}`);
    const name = taxonomyTypeName(taxonomy.slug);
    if (names.has(name)) throw new Error(`Taxonomy names collide: ${name}`);
    names.add(name);
    const byId = new Map(terms.map(term => [term.id, term]));
    if (byId.size !== terms.length) throw new Error(`Duplicate term IDs in ${taxonomy.slug}`);
    byTaxonomy.set(taxonomy.slug, byId);
    const fields = new Map<string, FieldDefinition>();
    for (const term of terms) {
      for (const field of inferContentType({ slug: name, name: taxonomy.name, rest_base: name }, term as unknown as WPItem).fields) {
        if (!['excerpt', 'featured_image'].includes(field.name)) {
          const existing = fields.get(field.name);
          if (existing && existing.type !== field.type) throw new Error(`Inconsistent taxonomy field ${name}.${field.name}; map its type before importing.`);
          fields.set(field.name, field);
        }
      }
    }
    contentTypes.push({ name, label_singular: taxonomy.name, label_plural: taxonomy.name,
      icon: 'tag', fields: [...fields.values()], route_template: `/${name}/{slug}`,
      sort_field: 'title', sort_dir: 'asc', created_at: now });
    for (const term of terms) {
      if (!Number.isSafeInteger(term.id) || term.id <= 0) throw new Error(`Invalid term ID in ${taxonomy.slug}`);
      const seen = new Set([term.id]);
      let ancestor = term;
      while (ancestor.parent) {
        if (seen.has(ancestor.parent)) throw new Error(`Taxonomy parent cycle in ${taxonomy.slug}: ${term.id}`);
        seen.add(ancestor.parent);
        const parent = byId.get(ancestor.parent);
        if (!parent) throw new Error(`Missing parent term ${taxonomy.slug}:${ancestor.parent}`);
        ancestor = parent;
      }
      const path = pathFromUrl(term.link, origin);
      if (!path) throw new Error(`Missing local archive URL for ${taxonomy.slug}:${term.id}`);
      const description = (term.description ?? '').trim();
      const descriptionBlocks: Block[] = description
        ? [{ id: 'taxonomy-description', type: 'core/prose', data: { html: description, max_width: 'normal' } }]
        : [];
      const listing: Block = { id: 'taxonomy-pages', type: 'core/repeater', data: {
        source_type: 'backlinks', item_block: 'core/post_card', cols: { mobile: 1, tablet: 2, desktop: 3 },
        limit: 0,
        item_overrides: { show_date: false, show_excerpt: false },
      } };
      pages.push({ id: taxonomyPageId(taxonomy.slug, term.id), title: normalizeWordPressPlainText(term.name),
        slug: term.slug, path, content_type: name, status: 'review', content_mode: 'blocks',
        blocks: [{ id: 'taxonomy-title', type: 'template/page_title', data: { level: 'h1', size: 'theme' } }, ...descriptionBlocks, listing],
        parent: term.parent ? taxonomyPageId(taxonomy.slug, term.parent) : undefined,
        fields: projectItemFields(term as unknown as WPItem, [...fields.values()], undefined),
        old_wp_url: term.link, date_published: now, date_updated: now });
    }
  }
  const relevant = (sourceType: string) => sources.filter(source => source.taxonomy.types.includes(sourceType));
  return {
    contentTypes, pages,
    fieldsFor: sourceType => relevant(sourceType).map(({ taxonomy }) => ({
      name: taxonomyTypeName(taxonomy.slug), label: taxonomy.name, type: 'page_ref_list', ref_content_type: taxonomyTypeName(taxonomy.slug),
    })),
    parentFor(item, sourceType) {
      // Use an explicit primary category when supplied; do not arbitrarily
      // choose one for a multi-category article.
      const category = relevant(sourceType).find(source => source.taxonomy.slug === 'category');
      if (!category) return undefined;
      const values = this.valuesFor(item, sourceType)[taxonomyTypeName('category')];
      const primary = (item._primary_terms as Record<string, number> | undefined)?.category;
      if (primary) {
        const id = taxonomyPageId('category', primary);
        if (!values.includes(id)) throw new Error(`Primary category ${primary} is not assigned to page ${item.id}`);
        return id;
      }
      return values.length === 1 ? values[0] : undefined;
    },
    valuesFor(item, sourceType) {
      const result: Record<string, string[]> = {};
      for (const { taxonomy } of relevant(sourceType)) {
        const helper = item._taxonomies as Record<string, Array<{ id: number }>> | undefined;
        const raw = helper ? (helper[taxonomy.slug] ?? []).map(term => term.id) : item[taxonomy.rest_base] ?? [];
        if (!Array.isArray(raw)) throw new Error(`Invalid terms on ${sourceType}:${item.id} (${taxonomy.slug})`);
        result[taxonomyTypeName(taxonomy.slug)] = [...new Set(raw)].map(id => {
          if (typeof id !== 'number' || !byTaxonomy.get(taxonomy.slug)?.has(id)) {
            throw new Error(`Missing term ${taxonomy.slug}:${String(id)} on ${sourceType}:${item.id}. Update the helper plugin or expose the taxonomy in WordPress REST.`);
          }
          return taxonomyPageId(taxonomy.slug, id);
        });
      }
      return result;
    },
  };
}
