import { CONFIGURABLE_PAGE_FIELDS, PAGE_BUILTIN_FIELDS } from '@typeroll/shared';
import { createHash } from 'node:crypto';
import { contentPagePath, DEFAULT_CONTENT_TYPE } from '@typeroll/shared';
import type { Block, BlockType, ContentType, FieldDefinition, Page, PageTemplate, Partial as PartialDoc } from '@typeroll/shared';
import { htmlToBlocks } from '../html-to-blocks';

/** Legacy shapes are confined to the offline migration, never the new runtime. */
export interface LegacyContentType {
  id: string; name: string; label_singular: string; label_plural: string;
  fields: LegacyField[]; route_template?: string; slug_field?: string;
  item_template_blocks?: Block[]; item_template_html?: string;
  [key: string]: unknown;
}
export interface LegacyField extends Omit<FieldDefinition, 'type' | 'fields'> {
  type: FieldDefinition['type'] | 'collection_ref' | 'item_ref' | 'item_ref_list';
  ref_collection?: string;
  fields?: LegacyField[];
}
export interface LegacyItem { id: string; [key: string]: unknown }
export interface LegacyContentSnapshot {
  version: string;
  pages: Page[];
  collections: Array<{ definition: LegacyContentType; items: LegacyItem[] }>;
  templates: PageTemplate[];
  blockTypes?: BlockType[];
  partials?: PartialDoc[];
}
export interface UnifiedContentSnapshot {
  version: string;
  pages: Page[];
  contentTypes: ContentType[];
  templates: PageTemplate[];
  blockTypes: BlockType[];
  partials: PartialDoc[];
  mappings: Array<{ collection: string; item: string; page: string }>;
  warnings: Array<{ page: string; message: string }>;
}
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const key = (type: string, id: string) => JSON.stringify([type, id]);
const systemFields = new Set([...PAGE_BUILTIN_FIELDS, 'created_at', 'updated_at', 'published_at']);
const fieldName = (name: string) => ({ published_at: 'date_published', updated_at: 'date_updated', body: 'body', toc_html: 'outline_html' }[name] ?? name);
const tokenPath = (name: string) => name.split('.').map((part, index) => index === 0 ? fieldName(part) : part).join('.');

/** Only template tokens change namespace. Editorial prose and repeater item contexts do not. */
export function migrateTemplateTokens(input: string, itemContext = false, bareFields = false): string {
  return input.replace(/(\{\{\{?\s*[#/^]?\s*)([\w.-]+)(\s*\}\}\}?)/g, (match, open: string, name: string, close: string) => {
    if (name.startsWith('collection.')) return `${open}content_type.${name.slice(11)}${close}`;
    if (name.startsWith('item.') && !itemContext) return `${open}page.${tokenPath(name.slice(5))}${close}`;
    if (bareFields && !name.includes('.') && name !== 'children') return `${open}page.${fieldName(name)}${close}`;
    return match;
  });
}

function stableBlocks(blocks: Block[], identity: string): Block[] {
  let index = 0;
  const visit = (tree: Block[]): Block[] => tree.map(block => ({ ...block,
    id: `m-${createHash('sha256').update(`${identity}:${index++}`).digest('hex').slice(0, 20)}`,
    ...(block.children ? { children: visit(block.children) } : {}),
    ...(block.slots ? { slots: block.slots.map(visit) } : {}),
  }));
  return visit(blocks);
}

/** Names and template identities must agree across branches, including name collisions. */
function typeName(type: string, ids: Map<string, string>): string { return ids.get(key('$type', type)) ?? type; }

/** Resolve identities across ALL versions so the same record retains its ID on branches. */
export function unifiedPageIds(snapshots: LegacyContentSnapshot[]): Map<string, string> {
  const reserved = new Set(snapshots.flatMap(snapshot => snapshot.pages.map(page => page.id)));
  const sources = new Map<string, { type: string; id: string }>();
  for (const snapshot of snapshots) for (const { definition, items } of snapshot.collections)
    for (const item of items) sources.set(key(definition.name, item.id), { type: definition.name, id: item.id });
  const result = new Map<string, string>();
  const types = [...new Set(snapshots.flatMap(snapshot => snapshot.collections.map(({ definition }) => definition.name)))].sort();
  const typeNames = new Set(['page', ...types.filter(name => name !== 'page')]);
  const templateNames = new Set(snapshots.flatMap(snapshot => snapshot.templates.map(template => template.id)));
  for (const name of types) {
    let target = name;
    if (name === 'page') {
      target = 'content-page';
      let suffix = 1;
      while (typeNames.has(target)) target = `content-page-${suffix++}`;
    }
    typeNames.add(target); result.set(key('$type', name), target);
    let template = `content-type-${target}`, suffix = 1;
    while (templateNames.has(template)) template = `content-type-${target}-${suffix++}`;
    templateNames.add(template); result.set(key('$template', name), template);
  }
  for (const [source, { type, id }] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    let candidate = id, suffix = 0;
    while (reserved.has(candidate)) candidate = `page-${type.length}-${type}-${id}${suffix++ ? `-${suffix}` : ''}`;
    if (candidate.includes('/') || candidate.length > 1000) throw new Error(`Cannot safely migrate page ID for ${type}`);
    reserved.add(candidate); result.set(source, candidate);
  }
  return result;
}

export function migrateContentSnapshot(snapshot: LegacyContentSnapshot, ids: Map<string, string>, now: string): UnifiedContentSnapshot {
  const warnings: UnifiedContentSnapshot['warnings'] = [];
  const blockTypes = structuredClone(snapshot.blockTypes ?? []);
  const templates: PageTemplate[] = [];
  const mappings: UnifiedContentSnapshot['mappings'] = [];
  const mapRef = (type: string, value: unknown): unknown => Array.isArray(value)
    ? value.map(id => mapRef(type, id))
    : typeof value === 'string' ? ids.get(key(type, value)) ?? value : value;
  const migrateField = (field: LegacyField): FieldDefinition => {
    const { ref_collection, fields: nested, ...rest } = field;
    return { ...rest,
      type: field.type === 'item_ref' ? 'page_ref' : field.type === 'item_ref_list' ? 'page_ref_list' : field.type === 'collection_ref' ? 'content_type_ref' : field.type,
      ...(ref_collection ? { ref_content_type: typeName(ref_collection, ids) } : {}),
      ...(nested ? { fields: nested.map(migrateField) } : {}),
    };
  };
  const migrateValues = (values: Record<string, unknown>, fields: LegacyField[]): Record<string, unknown> => {
    const output = { ...values };
    for (const field of fields) {
      const value = output[field.name];
      if (value === undefined) continue;
      if ((field.type === 'item_ref' || field.type === 'item_ref_list') && field.ref_collection) output[field.name] = mapRef(field.ref_collection, value);
      if (field.type === 'collection_ref' && typeof value === 'string') output[field.name] = typeName(value, ids);
      if (field.fields && value && typeof value === 'object') output[field.name] = Array.isArray(value)
        ? value.map(entry => entry && typeof entry === 'object' ? migrateValues(entry, field.fields!) : entry)
        : migrateValues(value as Record<string, unknown>, field.fields);
    }
    return output;
  };
  const repeaterBlocks = new Set(blockTypes.filter(type => type.container === 'repeater').map(type => type.id));
  ['core/repeater', 'core/collection_list', 'core/page_list', 'core/gallery'].forEach(id => repeaterBlocks.add(id));
  const pageBlockVariants = new Map<string, string>();
  const migrateBlocks = (blocks: Block[], itemContext = false): Block[] => blocks.map(block => {
    const result: Block = { ...block, data: { ...block.data } };
    const custom = blockTypes.find(type => type.id === block.type);
    if (!itemContext && custom?.item_compatible && /\bitem\./.test(custom.template ?? '')) {
      let variant = pageBlockVariants.get(custom.id);
      if (!variant) {
        variant = `${custom.id}-page-${createHash('sha256').update(custom.id).digest('hex').slice(0, 8)}`;
        if (blockTypes.some(type => type.id === variant)) throw new Error(`Page block variant conflicts with existing block type: ${variant}`);
        pageBlockVariants.set(custom.id, variant);
        blockTypes.push({ ...structuredClone(custom), id: variant, name: variant, item_compatible: false });
      }
      result.type = variant;
    }
    if (result.type === 'template/item_title') {
      result.type = itemContext ? 'core/heading' : 'template/page_title';
      if (itemContext) result.data.text = '{{item.title}}';
    }
    if (result.type === 'template/item_body') {
      const bodyField = String(result.data.field || 'body');
      result.type = bodyField === 'body' ? 'template_content_slot' : 'core/prose';
      if (bodyField !== 'body') result.data.html = `{{page.${bodyField}}}`;
      if (itemContext) { result.type = 'core/prose'; result.data.html = `{{item.${String(result.data.field || 'body')}}}`; }
    }
    if (result.type === 'template/item_image') {
      result.type = itemContext ? 'core/image' : 'template/page_featured_image';
      if (itemContext) result.data.src = `{{item.${String(result.data.field || 'image')}}}`;
    }
    if (result.type === 'template/item_navigation') result.type = 'template/page_navigation';
    if (result.type === 'core/collection_list') result.type = 'core/page_list';
    const sourceType = string(result.data.collection);
    if (sourceType) {
      result.data.content_type = typeName(sourceType, ids); delete result.data.collection;
      if (Array.isArray(result.data.pinned_ids)) result.data.pinned_ids = mapRef(sourceType, result.data.pinned_ids);
      if (Array.isArray(result.data.ids)) result.data.ids = mapRef(sourceType, result.data.ids);
    }
    if (result.data.source_type === 'collection') result.data.source_type = 'pages';
    if (typeof result.data.sort_by === 'string') result.data.sort_by = fieldName(result.data.sort_by);
    const schema = blockTypes.find(type => type.id === block.type)?.schema;
    if (schema) result.data = migrateValues(result.data, schema as LegacyField[]);
    for (const [field, value] of Object.entries(result.data)) if (typeof value === 'string') {
      result.data[field] = migrateTemplateTokens(value, itemContext || (repeaterBlocks.has(block.type) && field === 'item_template'));
    }
    if (result.type === 'template/show_if' && typeof result.data.condition === 'string') {
      // Rewrite expression identifiers, never quoted string literals.
      result.data.condition = result.data.condition.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g).map((part, i) => i % 2 ? part : part.replace(/\b(collection|item)\.([a-zA-Z_][\w.]*)/g, (match, namespace, path) => namespace === 'collection' ? `content_type.${path}` : itemContext ? match : `page.${tokenPath(path)}`)).join('');
    }
    const childContext = itemContext || repeaterBlocks.has(block.type);
    if (block.children) result.children = migrateBlocks(block.children, childContext);
    if (block.slots) result.slots = block.slots.map(slot => migrateBlocks(slot, childContext));
    return result;
  });
  templates.push(...snapshot.templates.map(template => ({ ...template,
    applies_to: String(template.applies_to).startsWith('collection:')
      ? `content_type:${typeName(String(template.applies_to).slice(11), ids)}` as const : template.applies_to,
    blocks: migrateBlocks(template.blocks),
  })));
  const convertBody = (body: string, identity: string): Block[] => {
    const conversion = htmlToBlocks(body);
    for (const message of conversion.notes) warnings.push({ page: identity, message });
    return stableBlocks(conversion.blocks, identity);
  };
  const pages: Page[] = snapshot.pages.map(page => {
    const { html_content, ...rest } = page;
    return { ...rest, path: page.path || (['', 'home', 'index'].includes(page.slug) ? '/' : `/${page.slug}`),
      content_type: 'page', fields: page.fields ?? {}, content_mode: 'blocks',
      blocks: migrateBlocks(page.content_mode === 'blocks' ? page.blocks ?? [] : convertBody(html_content ?? '', page.id)),
    };
  });
  const partials = (snapshot.partials ?? []).map(partial => ({ ...partial,
    ...(partial.content_mode === 'blocks' ? { blocks: migrateBlocks(partial.blocks ?? []) } : { html_content: migrateTemplateTokens(partial.html_content ?? '') }),
  }));
  const contentTypes: ContentType[] = [{ ...DEFAULT_CONTENT_TYPE }];
  for (const { definition, items } of snapshot.collections) {
    const typeId = typeName(definition.name, ids);
    if (contentTypes.some(type => type.id === typeId)) throw new Error(`Duplicate content type ${typeId}`);
    const templateId = ids.get(key('$template', definition.name));
    if (!templateId) throw new Error(`Missing template mapping for ${definition.name}`);
    let blocks = definition.item_template_blocks;
    if (!blocks?.length && definition.item_template_html?.trim()) {
      // Keep the layout HTML once, while the editable body is a tree of native blocks.
      // Preserve layouts that omit or repeat the body as well.
      const bodySlots = definition.item_template_html.match(/\{\{\{?\s*(?:item\.)?body\s*\}\}\}?/g) ?? [];
      let sourceMarkup = definition.item_template_html;
      for (const slot of bodySlots) sourceMarkup = sourceMarkup.replace(slot, '{{children}}');
      const markup = migrateTemplateTokens(sourceMarkup, false, true);
      const blockId = `migrated-layout-${createHash('sha256').update(markup).digest('hex').slice(0, 20)}`;
      if (!blockTypes.some(type => type.id === blockId)) blockTypes.push({ id: blockId, name: blockId, label: `${definition.label_singular} layout`,
        category: 'custom', origin: 'user', container: true, schema: [], template: markup, created_at: now });
      blocks = [{ id: `${templateId}-layout`, type: blockId, data: {}, children: bodySlots.length ? [{ id: `${templateId}-body`, type: 'template_content_slot', data: {} }] : [] }];
      warnings.push({ page: `content_type:${typeId}`, message: 'Preserved HTML layout as a shared container block; the page body uses editable blocks.' });
    }
    blocks = blocks?.length ? migrateBlocks(blocks) : [
      { id: 'page-title', type: 'template/page_title', data: {} },
      { id: 'page-body', type: 'template_content_slot', data: {} },
    ];
    templates.push({ id: templateId, name: templateId, label: definition.label_singular, blocks, status: 'published', created_at: now, date_updated: now });
    const page_field_rules = Object.fromEntries(definition.fields.filter(field => CONFIGURABLE_PAGE_FIELDS.some(common => common.name === field.name) && field.writable_by).map(field => [field.name, { label: field.label, writable_by: field.writable_by! }]));
    const fields = definition.fields.filter(field => !systemFields.has(field.name)).map(migrateField);
    const undeclared = new Set(items.flatMap(item => Object.keys(item).filter(name => !systemFields.has(name) && !name.startsWith('_') && !fields.some(field => field.name === name))));
    for (const name of undeclared) {
      const value = items.map(item => item[name]).find(value => value != null);
      const type = Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';
      fields.push({ name, label: name, type, rendered: false });
      warnings.push({ page: `content_type:${typeId}`, message: `Preserved undeclared field ${name} as a private custom field; review before exposing it publicly.` });
    }
    const route = definition.route_template ?? `/${definition.name}/{${definition.slug_field || 'slug'}}`;
    contentTypes.push({
      id: typeId, name: typeId, label_singular: definition.label_singular, label_plural: definition.label_plural,
      fields, route_template: route.replace(/\{([^}]+)\}/g, (_match, name: string) => `{${name === definition.slug_field ? 'slug' : fieldName(name)}}`),
      template: templateId, created_at: string(definition.created_at, now),
      ...(definition.icon ? { icon: string(definition.icon) } : {}),
      ...(definition.sort_field ? { sort_field: fieldName(string(definition.sort_field)), sort_dir: definition.sort_dir === 'desc' ? 'desc' as const : 'asc' as const } : {}),
      ...(definition.schema_type ? { schema_type: string(definition.schema_type) } : {}),
      ...(Object.keys(page_field_rules).length ? { page_field_rules } : {}),
      ...(definition.schema_field_map ? { schema_field_map: Object.fromEntries(Object.entries(definition.schema_field_map as Record<string, string>).map(([property, name]) => [property, fieldName(name)])) } : {}),
      ...(definition.facets ? { facets: definition.facets as ContentType['facets'] } : {}),
      ...(definition.facet_combinations ? { facet_combinations: definition.facet_combinations as ContentType['facet_combinations'] } : {}),
    });
    for (const item of items) {
      const id = ids.get(key(definition.name, item.id));
      if (!id) throw new Error(`Missing ID mapping for ${definition.name}`);
      const custom = migrateValues(Object.fromEntries(Object.entries(item).filter(([field]) => !systemFields.has(field) && !field.startsWith('_'))), definition.fields);
      const body = string(item.body);
      const bodyBlocks = item.content_mode === 'blocks' && Array.isArray(item.blocks)
        ? item.blocks as Block[] : convertBody(body, id);
      const status = string(item.status, 'draft');
      if (!['draft', 'review', 'unlisted', 'published'].includes(status)) throw new Error(`Invalid status for page ${id}`);
      const page: Page = {
        id, title: string(item.title, string(item.name, definition.label_singular)),
        slug: string(item[definition.slug_field ?? 'slug']), content_type: typeId, fields: custom,
        content_mode: 'blocks', blocks: migrateBlocks(bodyBlocks), status: status as Page['status'],
        date_updated: string(item.date_updated, string(item.updated_at, now)), date_published: string(item.date_published, string(item.published_at, string(item.created_at, now))),
        ...(item._provenance ? { _provenance: item._provenance as Page['_provenance'] } : {}),
        ...Object.fromEntries(['publish_at', 'unpublish_at', 'seo_title', 'seo_description', 'og_image', 'noindex', 'canonical_url', 'append_seo_suffix', 'seo_image_alt', 'author', 'old_wp_url', 'language', 'custom_css', 'alternates', 'path', 'parent', 'sort_order', 'json_ld', 'schema_type', 'service', 'lastmod_override', 'image_sizes_default'].filter(field => item[field] !== undefined).map(field => [field, item[field]])),
      };
      const path = contentPagePath(page, contentTypes[contentTypes.length - 1]);
      if (path) page.path = path;
      pages.push(page);
      mappings.push({ collection: definition.name, item: item.id, page: id });
    }
  }
  // Schema-defined reference fields on custom blocks move to the same native model.
  for (const type of blockTypes) {
    type.schema = type.schema.map(field => migrateField(field as LegacyField));
    if (type.template) type.template = migrateTemplateTokens(type.template, type.item_compatible === true || type.container === 'repeater');
  }
  const routes = new Map<string, string>();
  for (const page of pages) {
    const type = contentTypes.find(type => type.id === page.content_type)!;
    const path = contentPagePath(page, type);
    if (path && ['published', 'unlisted'].includes(page.status)) {
      if (routes.has(path)) throw new Error(`Duplicate public route ${path}: ${routes.get(path)} and ${page.id}`);
      routes.set(path, page.id);
    }
  }
  return { version: snapshot.version, pages, contentTypes, templates, blockTypes, partials, mappings, warnings };
}
