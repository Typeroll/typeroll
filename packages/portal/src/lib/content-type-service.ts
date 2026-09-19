import { schemaFieldMapError } from '@typeroll/shared';
import { DEFAULT_CONTENT_TYPE, PAGE_BUILTIN_FIELDS, CONFIGURABLE_PAGE_FIELDS, contentTypeAllowsTemplate, templateMatchesContentType, type ContentType, type FieldDefinition } from '@typeroll/shared';
import { vstore } from './version-store';
import { markSiteDirty } from './auto-deploy';
import { validatePageFields } from './page-fields';
export interface ContentTypeContext { orgId: string; siteId: string; versionId: string }
export class ContentTypeError extends Error { constructor(message: string, public status = 400) { super(message); } }
const writable = ['label_singular', 'label_plural', 'icon', 'fields', 'page_field_rules', 'route_template', 'sort_field', 'sort_dir', 'template', 'allowed_templates', 'schema_type', 'schema_field_map', 'schema_field_mode', 'facets', 'facet_combinations'] as const;
const fieldTypes = new Set(['text', 'textarea', 'richtext', 'image', 'file', 'color', 'select', 'multiselect', 'boolean', 'number', 'url', 'email', 'date', 'datetime', 'list', 'list_simple', 'array', 'object', 'page_ref', 'page_ref_list']);
export async function listContentTypes(ctx: ContentTypeContext): Promise<ContentType[]> {
  const types = await vstore.contentTypes(ctx.orgId, ctx.siteId, ctx.versionId);
  if (!types.some(type => type.id === 'page')) types.unshift(DEFAULT_CONTENT_TYPE);
  return types;
}
export async function saveContentType(ctx: ContentTypeContext, name: string, input: Record<string, unknown>, create = false): Promise<ContentType> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContentTypeError('JSON object required');
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name)) throw new ContentTypeError('Use a lowercase content type ID without spaces');
  const existing = (await listContentTypes(ctx)).find(type => type.id === name);
  if (create && existing) throw new ContentTypeError('Content type already exists', 409);
  if (!create && !existing) throw new ContentTypeError('Content type not found', 404);
  const patch = Object.fromEntries(writable.filter(field => field in input).map(field => [field, input[field]]));
  const next = { ...existing, ...patch, id: name, name, created_at: existing?.created_at ?? new Date().toISOString() } as ContentType;
  if (typeof next.label_singular !== 'string' || typeof next.label_plural !== 'string' || !next.label_singular.trim() || !next.label_plural.trim()) throw new ContentTypeError('Singular and plural labels are required');
  if (typeof next.route_template !== 'string' || (next.route_template && (!next.route_template.startsWith('/') || /[?#]|\.\.|\/\//.test(next.route_template)))) throw new ContentTypeError('URL pattern must start with /, or be empty for pages without a public URL');
  if (!Array.isArray(next.fields)) throw new ContentTypeError('fields must be an array');
  const names = new Set<string>();
  const validateSchema = (fields: FieldDefinition[], top = true, depth = 0): void => {
    if (!Array.isArray(fields) || depth > 8) throw new ContentTypeError('Field groups must be arrays with at most eight nesting levels');
    const used = top ? names : new Set<string>();
    for (const [index, field] of fields.entries()) {
      if (!field || typeof field.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(field.name)) throw new ContentTypeError(`fields[${index}]: use a lowercase field name starting with a letter`);
      if (used.has(field.name)) throw new ContentTypeError(`${field.name}: duplicate field name`);
      if (typeof field.label !== 'string' || !field.label.trim()) throw new ContentTypeError(`${field.name}: a nonempty label is required`);
      if (!fieldTypes.has(field.type)) throw new ContentTypeError(`${field.name}: unsupported field type ${String(field.type)}. Supported types: ${[...fieldTypes].join(', ')}`);
      if (field.type === 'multiselect' && (!Array.isArray(field.options) || !field.options.length)) throw new ContentTypeError(`${field.name}: multiselect requires options`);
      if (top && PAGE_BUILTIN_FIELDS.has(field.name)) throw new ContentTypeError(`${field.name} is already a built-in Page field`);
      used.add(field.name);
      if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some(option => typeof option !== 'string'))) throw new ContentTypeError(`${field.name}: choices must be strings`);
      if (field.type === 'multiselect' && new Set(field.options).size !== field.options?.length) throw new ContentTypeError(`${field.name}: choices must be unique`);
      if (field.writable_by !== undefined && (!Array.isArray(field.writable_by) || field.writable_by.some(actor => !['portal', 'agent', 'owner', 'app', 'import'].includes(actor)))) throw new ContentTypeError(`${field.name}: invalid write authority`);
      if (field.rendered !== undefined && typeof field.rendered !== 'boolean') throw new ContentTypeError(`${field.name}: rendered must be a boolean`);
      if (field.fields !== undefined) validateSchema(field.fields, false, depth + 1);
      if (field.item_key !== undefined && (!['array', 'list'].includes(field.type) ||
          !field.fields?.some(child => child.name === field.item_key && child.type === 'text')))
        throw new ContentTypeError(`${field.name}: item_key must identify a text field in an array or list`);
      if (field.default !== undefined) {
        const error = validatePageFields({ ...next, fields: [field] }, { [field.name]: field.default });
        if (error) throw new ContentTypeError(`Invalid default: ${error}`);
      }
    }
  };
  validateSchema(next.fields);
  if (next.page_field_rules !== undefined) {
    if (!next.page_field_rules || typeof next.page_field_rules !== 'object' || Array.isArray(next.page_field_rules)) throw new ContentTypeError('page_field_rules must be an object');
    for (const [name, rule] of Object.entries(next.page_field_rules)) {
      if (!CONFIGURABLE_PAGE_FIELDS.some(field => field.name === name) || !rule || typeof rule !== 'object'
        || !Array.isArray(rule.writable_by) || !rule.writable_by.length
        || rule.writable_by.some(actor => !['portal', 'agent', 'owner', 'app', 'import'].includes(actor))
        || (rule.label !== undefined && typeof rule.label !== 'string')) throw new ContentTypeError(`Invalid Page field rule: ${name}`);
    }
  }
  if (/[{}]/.test(next.route_template.replace(/\{[a-z][a-z0-9_]*\}/g, ''))) throw new ContentTypeError('URL pattern contains an invalid field token');
  for (const match of next.route_template.matchAll(/\{([^}]+)\}/g)) if (match[1] !== 'slug' && !names.has(match[1])) throw new ContentTypeError(`URL pattern uses unknown field ${match[1]}`);
  if (next.template != null && typeof next.template !== 'string') throw new ContentTypeError('Default template must be an ID');
  if (next.allowed_templates != null && (!Array.isArray(next.allowed_templates) || next.allowed_templates.some(id => typeof id !== 'string' || !id) || new Set(next.allowed_templates).size !== next.allowed_templates.length)) throw new ContentTypeError('Allowed templates must be a list of unique template IDs, or null for all compatible templates');
  const templates = await vstore.pageTemplates(ctx.orgId, ctx.siteId, ctx.versionId);
  for (const id of new Set([...(next.allowed_templates ?? []), ...(next.template ? [next.template] : [])])) {
    const template = templates.find(template => template.id === id);
    if (!template) throw new ContentTypeError(`Template not found: ${id}`);
    if (!templateMatchesContentType(template, next.id)) throw new ContentTypeError(`Template ${id} does not support this content type`);
    if (!contentTypeAllowsTemplate(next, template)) throw new ContentTypeError('The default template must be one of the allowed templates');
  }
  if (existing && ('allowed_templates' in input || 'template' in input)) {
    const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
    for (const page of pages.filter(page => (page.content_type ?? 'page') === name && page.template)) {
      const template = templates.find(template => template.id === page.template);
      if (!template || !contentTypeAllowsTemplate(next, template)) throw new ContentTypeError(`Page ${page.id} uses a template outside this selection. Change its template first.`, 409);
    }
  }
  if (next.sort_dir !== undefined && !['asc', 'desc'].includes(next.sort_dir)) throw new ContentTypeError('sort_dir must be asc or desc');
  if (next.sort_field && !names.has(next.sort_field) && !PAGE_BUILTIN_FIELDS.has(next.sort_field)) throw new ContentTypeError('Sort field not found');
  if (next.schema_field_mode !== undefined && !['all', 'mapped'].includes(next.schema_field_mode)) throw new ContentTypeError('schema_field_mode must be all or mapped');
  if (next.schema_field_map && (typeof next.schema_field_map !== 'object' || Array.isArray(next.schema_field_map) || Object.values(next.schema_field_map).some(value => typeof value !== 'string'))) throw new ContentTypeError('Schema field mappings must contain strings');
  const mappingError = schemaFieldMapError(next.schema_field_map);
  if (mappingError) throw new ContentTypeError(mappingError);
  if (next.facets !== undefined && (!Array.isArray(next.facets) || next.facets.some(facet => !facet || !names.has(facet.field) || typeof facet.base_path !== 'string' || !facet.base_path.startsWith('/')))) throw new ContentTypeError('Each facet needs a custom field and a URL starting with /');
  if (next.facet_combinations !== undefined && (!Array.isArray(next.facet_combinations) || next.facet_combinations.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1] || pair.some(field => typeof field !== 'string' || !next.facets?.some(facet => facet.field === field))))) throw new ContentTypeError('facet_combinations must contain pairs of distinct configured facet field names');
  await vstore.writeContentType(ctx.orgId, ctx.siteId, ctx.versionId, name, next);
  await markSiteDirty(ctx.orgId, ctx.siteId);
  return next;
}
export async function removeContentType(ctx: ContentTypeContext, name: string): Promise<void> {
  if (name === 'page') throw new ContentTypeError('The standard Page type cannot be deleted');
  const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
  if (pages.some(page => page.content_type === name)) throw new ContentTypeError('Move or delete the pages using this content type first', 409);
  await vstore.deleteContentType(ctx.orgId, ctx.siteId, ctx.versionId, name);
  await markSiteDirty(ctx.orgId, ctx.siteId);
}
