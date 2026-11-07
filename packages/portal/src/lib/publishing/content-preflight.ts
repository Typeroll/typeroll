import { blockTreeError, CORE_BLOCK_TYPES, findMenu, unknownSiteFieldReferences, unknownSnippetReferences, type SiteFieldGroup, isMenuNavigation, locationConflicts, resolveMenu, resolveRenderVersion, validateMenu, withGlobalBlockContent, globalBlockSourceFromPartials, type Block, type BlockType, type Menu, type MenuPage } from '@typeroll/shared';
import { projectPublicationBlocks, projectPublicationBlockTypes, projectPublicationSchema } from '../../../../../scripts/lib/publication-blocks.mjs';
import { ConnectionError } from './connections';

type Document = { id: string; [key: string]: any };
export interface ExportContent { pages: Document[]; partials: Document[]; menus?: Document[]; pageTemplates: Document[]; blockTypes: Document[]; contentTypes: Document[] }

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
  // Menus are saved validated; a menu that no longer validates would publish links nobody checked.
  for (const menu of content.menus ?? []) {
    const { errors } = validateMenu(menu);
    if (errors.length) fail(`menus/${menu.id}${errors[0]!.path ? `.${errors[0]!.path}` : ''}`, errors[0]!.message);
  }
  for (const type of content.contentTypes) for (const facet of type.facets ?? []) if (facet.template) used.add(facet.template);
  for (const id of used) {
    const template = templates.get(id);
    if (!template || template.status !== 'published') fail(`page_templates/${id}`, 'Referenced Page template must exist and be published.');
    tree(template!, `page_templates/${id}`, true);
  }
}

/**
 * Non-blocking menu findings for a frozen publication: locations two menus
 * claim, Navigation links blocks that name a menu that does not exist or
 * render before menus do (render version 15), and menu items whose page is
 * missing or unpublished. The publication still runs; the job lists them.
 */
export function publicationMenuWarnings(publication: { settings?: Record<string, any>; pages?: Document[]; partials?: Document[]; pageTemplates?: Document[]; menus?: Document[] }): string[] {
  const menus = (publication.menus ?? []) as unknown as Menu[];
  const warnings = locationConflicts(menus).map(location => `More than one menu fills the location "${location}"; Navigation links blocks show the first.`);
  const free = (publication.partials ?? []).filter(partial => partial.kind === 'free');
  const references = new Map<string, string>();
  const visit = (blocks: Block[], where: string) => {
    for (const block of withGlobalBlockContent(blocks, globalBlockSourceFromPartials(free as never))) {
      if (isMenuNavigation(block)) references.set(String(block.data?.menu ?? '').trim(), where);
      visit(block.children ?? [], where);
      for (const slot of block.slots ?? []) visit(slot, where);
    }
  };
  for (const page of publication.pages ?? []) if (Array.isArray(page.blocks)) visit(page.blocks, `page ${page.id}`);
  for (const partial of publication.partials ?? []) if (Array.isArray(partial.blocks)) visit(partial.blocks, `partial ${partial.id}`);
  for (const template of publication.pageTemplates ?? []) if (Array.isArray(template.blocks)) visit(template.blocks, `page template ${template.id}`);
  if (!references.size) return warnings;
  if (resolveRenderVersion(publication.settings?.render_version) < 15) {
    warnings.push(`Navigation links blocks that show a site menu render their own links until the site uses render version 15 (first in ${[...references.values()][0]}).`);
    return warnings;
  }
  const pages: MenuPage[] = (publication.pages ?? []).map(page => ({
    id: String(page.id), title: String(page.title ?? ''), path: String(page.path ?? `/${page.slug ?? ''}`),
    parent: page.parent ?? null, sort_order: typeof page.sort_order === 'number' ? page.sort_order : null, status: page.status,
  }));
  const resolved = new Set<string>();
  for (const [reference, where] of references) {
    const menu = findMenu(menus, reference);
    if (!menu) { warnings.push(reference ? `${where} shows the menu "${reference}", which does not exist; the block renders no links.` : `${where} has a Navigation links block that shows a site menu but names none.`); continue; }
    if (resolved.has(menu.id)) continue;
    resolved.add(menu.id);
    warnings.push(...resolveMenu(menu, pages, '/').warnings);
  }
  return warnings;
}

/**
 * Non-blocking site field findings for a frozen publication: Site field
 * blocks and `site.fields.*` conditions that name a field the site does not
 * define (or keeps private). Such a block renders nothing and such a
 * condition is false; the job lists them once per field.
 */
export function publicationSiteFieldWarnings(publication: { pages?: Document[]; partials?: Document[]; pageTemplates?: Document[]; siteFields?: { groups?: SiteFieldGroup[] } }): string[] {
  const definitions = publication.siteFields?.groups ?? [];
  const free = (publication.partials ?? []).filter(partial => partial.kind === 'free');
  const seen = new Set<string>();
  const warnings: string[] = [];
  const check = (blocks: unknown, where: string) => {
    if (!Array.isArray(blocks)) return;
    for (const name of unknownSiteFieldReferences(withGlobalBlockContent(blocks as Block[], globalBlockSourceFromPartials(free as never)), definitions)) {
      if (seen.has(name)) continue;
      seen.add(name);
      warnings.push(name
        ? `${where} reads the site field "${name}", which the site does not define or keeps private; a Site field block shows nothing for it and a condition on it is false.`
        : `${where} has a Site field block that names no field.`);
    }
  };
  for (const page of publication.pages ?? []) check(page.blocks, `page ${page.id}`);
  for (const partial of publication.partials ?? []) check(partial.blocks, `partial ${partial.id}`);
  for (const template of publication.pageTemplates ?? []) check(template.blocks, `page template ${template.id}`);
  return warnings;
}

/**
 * Non-blocking snippet findings for a frozen publication: Live snippet
 * blocks that name a snippet the site does not have. Such a block shows its
 * empty text (or nothing) until a snippet with that id exists and the page
 * is published again or fetches it.
 */
export function publicationSnippetWarnings(publication: { pages?: Document[]; partials?: Document[]; pageTemplates?: Document[]; snippets?: Array<{ id: string }> }): string[] {
  const known = new Set((publication.snippets ?? []).map(snippet => snippet.id));
  const free = (publication.partials ?? []).filter(partial => partial.kind === 'free');
  const seen = new Set<string>();
  const warnings: string[] = [];
  const check = (blocks: unknown, where: string) => {
    if (!Array.isArray(blocks)) return;
    for (const id of unknownSnippetReferences(withGlobalBlockContent(blocks as Block[], globalBlockSourceFromPartials(free as never)), known)) {
      if (seen.has(id)) continue;
      seen.add(id);
      warnings.push(id
        ? `${where} shows the live snippet "${id}", which the site does not have; the block shows its empty text or nothing.`
        : `${where} has a Live snippet block that names no snippet.`);
    }
  };
  for (const page of publication.pages ?? []) check(page.blocks, `page ${page.id}`);
  for (const partial of publication.partials ?? []) check(partial.blocks, `partial ${partial.id}`);
  for (const template of publication.pageTemplates ?? []) check(template.blocks, `page template ${template.id}`);
  return warnings;
}
