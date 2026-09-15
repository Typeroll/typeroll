import type { ContentType, FieldDefinition, Page } from './types.js';

export const PAGE_BUILTIN_FIELDS = new Set([
  'id', 'title', 'slug', 'path', 'parent', 'sort_order', 'template', 'content_type', 'fields', 'body', 'blocks',
  'content_mode', 'html_content', 'status', 'seo_title', 'append_seo_suffix', 'seo_description', 'og_image',
  'seo_image_alt', 'canonical_url', 'noindex', 'alternates', 'lastmod_override', 'json_ld', 'kind', 'schema_type',
  'service', 'author', 'language', 'image_sizes_default', 'old_wp_url', 'ai_generated', 'date_published',
  'date_updated', 'publish_at', 'unpublish_at', 'custom_css',
]);

/** Common metadata that a content type can expose to a scoped editor. */
export const CONFIGURABLE_PAGE_FIELDS: FieldDefinition[] = [
  { name: 'title', type: 'text', label: 'Title' },
  { name: 'author', type: 'text', label: 'Author' },
  { name: 'seo_title', type: 'text', label: 'SEO title' },
  { name: 'seo_description', type: 'textarea', label: 'Description' },
  { name: 'og_image', type: 'image', label: 'Social image' },
  { name: 'seo_image_alt', type: 'text', label: 'Image description' },
];
export function pageAuthorityFields(type: ContentType): FieldDefinition[] {
  return [...type.fields, ...CONFIGURABLE_PAGE_FIELDS.flatMap(field => {
    const rule = type.page_field_rules?.[field.name];
    return rule ? [{ ...field, ...rule }] : [];
  })];
}

export const DEFAULT_CONTENT_TYPE: ContentType = {
  id: 'page', name: 'page', label_singular: 'Page', label_plural: 'Pages',
  fields: [], route_template: '/{slug}', created_at: '1970-01-01T00:00:00Z',
};

/** One rendering/query context for every page, including its type-defined fields. */
export function pageContentValues(page: Page): Record<string, unknown> {
  const publicPage = Object.fromEntries(Object.entries(page).filter(([key]) => !key.startsWith('_')));
  return { ...page.fields, ...publicPage, fields: page.fields ?? {}, body: page.html_content ?? '' };
}

/** The content type owns routing; an explicit path is a per-page override. */
export function contentPagePath(page: Page, type: ContentType): string | null {
  if (!type.route_template) return null;
  if (page.path) return page.path;
  const values = pageContentValues(page);
  let missing = false;
  const path = type.route_template.replace(/\{([^}]+)\}/g, (_match, field: string) => {
    const value = values[field];
    if (value == null || value === '') {
      if (field === 'slug' && type.id === 'page') return '';
      missing = true; return '';
    }
    return String(value).split('/').map(segment => encodeURIComponent(segment.trim())).join('/');
  });
  return missing ? null : (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/, '') || '/';
}

/** Resolve defaults for rendering without writing derived values into storage. */
export function resolveContentPage(page: Page, type: ContentType): Page | null {
  const path = contentPagePath(page, type);
  if (path === null) return null;
  return { ...page, content_type: type.id, path, template: page.template || type.template };
}

/** Never expose private custom fields or editorial provenance to a static build. */
export function publicContentPage(page: Page, type: ContentType): Page {
  const project = (value: Record<string, unknown>, schema: FieldDefinition[]): Record<string, unknown> => {
    const fields = new Map(schema.map(field => [field.name, field]));
    return Object.fromEntries(Object.entries(value).flatMap(([name, entry]) => {
      const field = fields.get(name);
      if (!field || field.rendered === false || name.startsWith('_')) return [];
      if (field?.fields && entry && typeof entry === 'object') {
        const clean = (child: unknown) => child && typeof child === 'object' && !Array.isArray(child) ? project(child as Record<string, unknown>, field.fields!) : child;
        return [[name, Array.isArray(entry) ? entry.map(clean) : clean(entry)]];
      }
      return [[name, entry]];
    }));
  };
  const fields = project(page.fields ?? {}, type.fields);
  const clean = Object.fromEntries(Object.entries(page).filter(([name]) => !name.startsWith('_')));
  return { ...clean, fields } as unknown as Page;
}
