import { blockTreeError, CORE_BLOCK_TYPES, type Block, type BlockType } from '@typeroll/shared';
import { projectPublicationBlocks, projectPublicationBlockTypes, projectPublicationSchema } from '../../../../../scripts/lib/publication-blocks.mjs';
import { ConnectionError } from './connections';

type Document = { id: string; [key: string]: any };
export interface ExportContent { pages: Document[]; partials: Document[]; pageTemplates: Document[]; blockTypes: Document[]; contentTypes: Document[] }

/** Pure export validation: no render, media copy, provider call or publication. */
export function assertContentExportable(content: ExportContent): void {
  const fail = (path: string, message: string): never => { throw new ConnectionError(`${path}: ${message}`, 409, 'content_export_invalid'); };
  let custom: ReturnType<typeof projectPublicationBlockTypes> = [];
  try { custom = projectPublicationBlockTypes(content.blockTypes, CORE_BLOCK_TYPES); }
  catch (error) { fail('block_types', error instanceof Error ? error.message : 'Invalid block definitions'); }
  const definitions = [...CORE_BLOCK_TYPES, ...custom] as BlockType[];
  const registry = new Map(definitions.map(definition => [definition.id, definition]));
  const types = new Map(content.contentTypes.map(type => [type.id, type]));
  const templates = new Map(content.pageTemplates.map(template => [template.id, template]));
  const used = new Set<string>();
  function references(blocks: Block[], path: string) {
    for (const [index, block] of blocks.entries()) {
      const at = `${path}[${index}]`;
      let definition = registry.get(block.type), data = block.data ?? {};
      const seen = new Set<string>();
      while (definition?.expand_to) {
        if (seen.has(definition.id) || seen.size >= 5) fail(at, 'Block alias chain is invalid.');
        seen.add(definition.id);
        data = { ...definition.expand_to.defaults, ...data };
        definition = registry.get(definition.expand_to.target);
      }
      for (const field of definition?.schema ?? []) {
        if (field.type !== 'block_type_ref' && field.type !== 'content_type_ref') continue;
        const value = data[field.name] ?? field.default;
        if (!value && !field.required) continue;
        const exists = field.type === 'block_type_ref' ? registry.has(String(value)) : value === 'page' || types.has(String(value));
        if (!exists) fail(`${at}.data.${field.name}`, `Referenced ${field.type === 'block_type_ref' ? 'block' : 'content'} type is missing.`);
      }
      if (block.children) references(block.children, `${at}.children`);
      for (const [slot, children] of (block.slots ?? []).entries()) references(children, `${at}.slots[${slot}]`);
    }
  }
  function tree(doc: Document, path: string, template = false) {
    const blocks = doc.blocks;
    const error = blockTreeError(blocks, `${path}.blocks`, true);
    if (error) fail(path, error);
    references(blocks, `${path}.blocks`);
    try { projectPublicationBlocks(blocks, template ? [...definitions, { id: 'template_content_slot', schema: [] }] : definitions); }
    catch (error) { fail(path, error instanceof Error ? error.message : 'Invalid blocks'); }
  }
  for (const type of content.contentTypes) {
    try { projectPublicationSchema(type.fields); }
    catch (error) { fail(`content_types/${type.id}`, error instanceof Error ? error.message : 'Invalid field schema.'); }
  }
  for (const page of content.pages) {
    if (!['published', 'unlisted'].includes(page.status)) continue;
    const path = `pages/${page.id}`;
    if (!['html', 'blocks'].includes(page.content_mode)) fail(path, 'Content mode must be html or blocks.');
    const type = types.get(page.content_type ?? 'page');
    if (page.content_type && page.content_type !== 'page' && !type) fail(path, 'Content type is missing.');
    if (page.content_mode === 'blocks') tree(page, path);
    const templateId = page.template || type?.template;
    if (templateId) used.add(templateId);
  }
  for (const partial of content.partials) {
    if (!['html', 'blocks'].includes(partial.content_mode)) fail(`partials/${partial.id}`, 'Content mode must be html or blocks.');
    if (partial.content_mode === 'blocks') tree(partial, `partials/${partial.id}`);
  }
  for (const type of content.contentTypes) for (const facet of type.facets ?? []) if (facet.template) used.add(facet.template);
  for (const id of used) {
    const template = templates.get(id);
    if (!template || template.status !== 'published') fail(`page_templates/${id}`, 'Referenced Page template must exist and be published.');
    tree(template!, `page_templates/${id}`, true);
  }
}
