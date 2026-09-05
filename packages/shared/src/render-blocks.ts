// Block-tree → HTML renderer.
//
// Pure function used by both the SSG renderer (packages/site-template) and
// the portal's editor preview (packages/portal). Takes a `Block[]` tree plus
// a registry of `BlockType`s and produces an HTML string. The caller is
// expected to pass the output through the customer-HTML sanitizer as a final
// defense-in-depth pass — this renderer trusts its template inputs (templates
// come from core, trusted user authoring, or signed third-party packages),
// but it never trusts block `data` fields, which are HTML-escaped on
// substitution.
//
// Substitution syntax inside `BlockType.template`:
//   {{field}}          — HTML-escaped value of `block.data.field`
//   {{{field}}}        — raw (for richtext fields that intentionally carry HTML)
//   {{=field}}         — HTML tag-name substitution. Value is validated
//                        against a small allowlist of safe semantic tags
//                        (h1..h6, p, div, span, section, article, aside,
//                        nav, header, footer, main, figure, figcaption,
//                        blockquote, cite, em, strong, small, ul, ol, li).
//                        Invalid values fall back to `div` so the renderer
//                        can never emit `<script>` even if data is malformed.
//                        Used for fields like `level` (`<{{=level}}>…</{{=level}}>`)
//                        where the tag itself varies with author input.
//   {{children}}       — recursive render of `block.children` (container blocks)
//   {{slot:NAME}}      — render the named slot from `block.slots`. NAME matches
//                        BlockType.slot_labels[i] (case-insensitive) or the
//                        positional index ("slot:0", "slot:1" …).
//
// Unknown block types fall through to a `<!-- unknown block: type -->`
// comment so debugging is obvious without breaking the render. The
// `template_content_slot` block type is special-cased by callers (page +
// template composition), not handled here.

import {
  BREAKPOINTS_ABOVE_MOBILE,
  isResponsiveValue,
  mediaQuery,
  resolveResponsive,
  type Breakpoint,
} from './breakpoints.js';
import type { Block, BlockType, FieldDefinition } from './types.js';
import { renderIconHtml } from './icons.js';
import { backlinksFor, refIds, type BacklinkIndex } from './item-refs.js';
import { applyTrailingSlash, type TrailingSlashPolicy } from './url-policy.js';
import { prepareHeadingOutline } from './heading-outline.js';

/**
 * Render context — values exposed to templates via the dotted-path
 * substitution syntax (`{{page.title}}`, `{{site.logo}}`, `{{item.name}}`).
 * Block-local fields (`{{field}}`) stay namespace-less and continue to
 * resolve against `block.data`.
 *
 * `page` and `site` are typically static for one render pass; `item` /
 * `collection` change per-iteration inside a repeater loop (the renderer
 * pushes/pops these automatically).
 */
export interface RenderContext {
  page?: Record<string, unknown>;
  /** Build with `siteContext(settings)` — see the note there on `site.name`. */
  site?: Record<string, unknown>;
  item?: Record<string, unknown>;
  collection?: Record<string, unknown>;
  /**
   * Archive pagination for a repeater with `paginate` set (collection
   * sources only). `current` is 1-based; `base_url` is the page's own URL.
   * Route generation lives in the SSG ([...slug].astro
   * emits the /page/N/ paths via countPaginatedRoutes); previews render
   * page 1.
   */
  pagination?: { current: number; base_url: string; trailing_slash?: TrailingSlashPolicy };
  /**
   * Reverse reference index, for `source_type: 'backlinks'` repeaters.
   * Computed by the caller from the item set it already loaded, never stored
   * — see item-refs.ts for why maintaining both directions rots.
   */
  backlinks?: BacklinkIndex;
  /**
   * Taxonomy scope, set on a facet page. A `core/collection_list` that
   * declares no filter of its own inherits this — so the same listing block
   * works unchanged on a normal page and on /bransch/rormokare/, instead of
   * the author having to hand-configure a filter per generated page.
   */
  facet?: { filters: Array<{ field: string; value: string; label_singular: string }> };
}

export interface RenderBlocksOptions {
  /**
   * Lookup of available block types. Keyed by `BlockType.id`. The renderer
   * does NOT mutate the map. Pass core + user + third-party + ai blocks
   * already merged.
   */
  registry: Map<string, BlockType> | Record<string, BlockType>;
  /**
   * Called when a block references a type that isn't in the registry. Default
   * emits an HTML comment. Override in dev to throw, or in preview to render
   * a visible placeholder.
   */
  onMissingType?: (typeId: string, block: Block) => string;
  /**
   * Dynamic render context — values exposed to templates via dotted-path
   * substitution (`{{page.title}}`, `{{site.logo}}`, …). Optional; if
   * omitted, dotted tokens resolve to empty strings.
   */
  context?: RenderContext;
  /**
   * Provider for repeater `source_type: 'collection'` items. Called when
   * a `core/repeater` block has its source set to a collection — the
   * caller supplies the items so the renderer stays free of datastore
   * code. Items should already be filtered, sorted, and limited
   * according to the repeater's config.
   *
   * Synchronous to keep `renderBlocks` synchronous; callers typically
   * resolve all collection sources up-front before invoking the
   * renderer.
   */
  collectionSource?: (config: {
    collection: string;
    /**
     * Return exactly these items, in this order, ignoring sort/filter. Used
     * by the `related` and `backlinks` repeater sources, where the id list IS
     * the query. Ids that no longer exist are skipped by the resolver.
     */
    ids?: string[];
    limit?: number;
    sort_by?: string;
    sort_order?: 'asc' | 'desc';
    filter_field?: string;
    filter_value?: string;
    pinned_ids?: string[];
  }) => Record<string, unknown>[];
  /**
   * Forms 2.0: resolver for core/form blocks. Receives the block's form_id
   * and returns the complete form markup (renderFormHtml output — the
   * caller owns token minting + pow config), or undefined when the form
   * doesn't exist. Without a formSource, core/form renders a comment.
   */
  formSource?: (formId: string) => string | undefined;
  /**
   * When true, every block's root element is tagged with `data-block-id`
   * (the authored block id) and `data-block-type` (the authored type). Lets an
   * agent map the rendered HTML back to the exact block to edit — closing the
   * gap between "understand the page" (rendered HTML) and "edit the page"
   * (block tree). Off by default so production output stays clean.
   */
  annotate?: boolean;
  /**
   * Editor-only inline editing: wrap each plain-text field's TEXT-CONTEXT
   * substitution in `<span data-edit="{blockId}:{field}">…</span>` so the
   * editor canvas can flip it contentEditable. Only `type: 'text'` schema
   * fields, only outside tags (attribute occurrences untouched), and only
   * when the stored value has no `{{…}}` context binding (rendered text ≠
   * stored value there). Off everywhere except the editor iframe preview.
   */
  editable?: boolean;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

function getRegistryEntry(
  registry: RenderBlocksOptions['registry'],
  typeId: string,
): BlockType | undefined {
  if (registry instanceof Map) return registry.get(typeId);
  return registry[typeId];
}

/**
 * Render a single block to HTML using its BlockType template. Recurses into
 * children/slots. Does NOT sanitize — the caller is responsible.
 *
 * Pre-render passes:
 *   1. Alias expansion — if `blockType.expand_to` is set, swap the block
 *      type for the target and merge the alias's defaults under the
 *      block's data. The page tree stays readable; the renderer reuses
 *      the target's template + styles.
 *   2. Repeater — if the resolved type's `container === 'repeater'`,
 *      hand off to `renderRepeater()` which loops the source and renders
 *      each item with the configured `item_block`.
 */
export function renderBlock(block: Block, options: RenderBlocksOptions): string {
  let blockType = getRegistryEntry(options.registry, block.type);
  if (!blockType) {
    const fallback = options.onMissingType ?? defaultMissingType;
    return fallback(block.type, block);
  }

  // (1) Alias expansion. Follow `expand_to` until we hit a real block,
  // merging defaults under the block's authored data each step.
  let effectiveBlock: Block = block;
  let safety = 5;
  while (blockType.expand_to && safety-- > 0) {
    const target = getRegistryEntry(options.registry, blockType.expand_to.target);
    if (!target) break;
    effectiveBlock = {
      ...effectiveBlock,
      type: target.id,
      data: { ...blockType.expand_to.defaults, ...effectiveBlock.data },
    };
    blockType = target;
  }

  // (1b) Forms 2.0: core/form delegates to the caller's formSource —
  // token minting and step prerendering live outside the pure renderer.
  if (effectiveBlock.type === 'core/form' && options.formSource) {
    const formId = String(effectiveBlock.data?.form_id ?? '');
    const html = formId ? options.formSource(formId) : undefined;
    return html ?? `<!-- core/form: unknown form_id ${escapeHtml(formId)} -->`;
  }

  // (2) Repeater container. Diverge here — the regular template path
  // doesn't know how to loop over items.
  if (blockType.container === 'repeater') {
    const compiled = compileResponsiveData(effectiveBlock, blockType);
    const responsiveBlock: Block = { ...effectiveBlock, data: compiled.flatData };
    let html = renderRepeater(responsiveBlock, blockType, options);
    // Annotate the repeater's own root so the rendered element maps back to
    // the authored (alias) block — its looped items carry synthetic ids that
    // aren't in the tree, so without this a repeater would be an un-targetable
    // hole for the editor's canvas hit-test. Uses the pre-alias id + type to
    // match get_page_blocks (same contract as the normal path below).
    if (options.annotate && block.id) {
      html = injectAttrsIntoFirstTag(html, { 'data-block-id': block.id, 'data-block-type': block.type });
    }
    if (compiled.hasOverrides) {
      html += renderResponsiveStyleBlock(
        sanitizeCssId(effectiveBlock.id),
        compiled.cssVars,
        compiled.mappedCss,
      );
    }
    html = applyStyleOverrides(html, effectiveBlock);
    return html;
  }

  // (3) Conditional container. Render children only if the condition
  // (a tiny expression against the context) is truthy. Useful for
  // template blocks like "only show the featured image section if the
  // page has one".
  if (blockType.container === 'conditional') {
    const cond = String(effectiveBlock.data?.condition ?? '');
    if (!evaluateCondition(cond, options.context, effectiveBlock.data ?? {})) {
      return '';
    }
    return effectiveBlock.children ? renderBlocks(effectiveBlock.children, options) : '';
  }

  let template = blockType.template ?? '';
  // Inline-edit stamping happens on the TEMPLATE (before substitution) so
  // the wrapper always encloses exactly the field's own token.
  if (options.editable && block.id) {
    template = stampEditableTextTokens(template, blockType, effectiveBlock, block.id);
  }
  const compiled = compileResponsiveData(effectiveBlock, blockType);

  // A block field may bind exactly to typed render context, e.g.
  // core/button.href = "{{item.pdf_url}}". Resolve only exact bindings and
  // only on inert text/URL/image fields; rich HTML remains an explicit block
  // concern and never gains recursive template evaluation.
  for (const field of blockType.schema ?? []) {
    if (!['text', 'textarea', 'url', 'image', 'file', 'email'].includes(field.type)) continue;
    const value = compiled.flatData[field.name];
    if (typeof value !== 'string') continue;
    const match = value.match(/^\s*\{\{\s*((?:page|site|item|collection)\.[\w.-]+)\s*\}\}\s*$/);
    if (match) compiled.flatData[field.name] = resolveDottedToken(match[1]!, compiled.flatData, options.context) ?? '';
  }

  if (effectiveBlock.type === 'template/item_body') {
    const fieldName = String(compiled.flatData.field ?? 'body');
    const raw = options.context?.item?.[fieldName];
    compiled.flatData.selected_item_body = prepareHeadingOutline(typeof raw === 'string' ? raw : '').html;
  }
  if (effectiveBlock.type === 'template/item_image') {
    const fieldName = String(compiled.flatData.field ?? 'image');
    compiled.flatData.selected_item_image = options.context?.item?.[fieldName] ?? '';
  }
  if (effectiveBlock.type === 'template/page_date') {
    const fieldName = String(compiled.flatData.field ?? 'published_at');
    compiled.flatData.selected_page_date = options.context?.item?.[fieldName]
      ?? options.context?.page?.[fieldName]
      ?? '';
  }
  if (effectiveBlock.type === 'template/page_breadcrumbs') {
    compiled.flatData.breadcrumbs_html = renderBreadcrumbs(
      options.context?.page?.breadcrumbs,
      String(compiled.flatData.home_label ?? 'Home'),
    );
  }
  if (effectiveBlock.type === 'core/table_of_contents') {
    const sourceField = String(compiled.flatData.source_field ?? 'body');
    const raw = options.context?.item?.[sourceField] ?? options.context?.page?.[sourceField];
    const prepared = prepareHeadingOutline(typeof raw === 'string' ? raw : '');
    const maxLevel = compiled.flatData.levels === 'h2' ? 2 : compiled.flatData.levels === 'h2-h4' ? 4 : 3;
    const headings = prepared.headings.filter((heading) => heading.level <= maxLevel);
    compiled.flatData.toc_items_html = headings
      .map((heading) => `<li data-level="${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`)
      .join('');
    compiled.flatData.toc_empty = headings.length === 0 ? 'true' : 'false';
  }
  if (effectiveBlock.type === 'template/item_navigation') {
    const item = options.context?.item ?? {};
    const collection = options.context?.collection ?? {};
    const previous = navigationLinkData('previous', compiled.flatData, item, collection);
    const next = navigationLinkData('next', compiled.flatData, item, collection);
    compiled.flatData.previous_url = previous.url;
    compiled.flatData.previous_title = previous.title;
    compiled.flatData.previous_empty = previous.url ? 'false' : 'true';
    compiled.flatData.next_url = next.url;
    compiled.flatData.next_title = next.title;
    compiled.flatData.next_empty = next.url ? 'false' : 'true';
  }
  if (effectiveBlock.type === 'core/navigation') {
    compiled.flatData.navigation_links_html = renderNavigationLinks(
      effectiveBlock.data?.links,
      options.context?.page,
    );
  }
  if (effectiveBlock.type === 'core/post_card') {
    preparePostCardData(compiled.flatData, options.context?.item);
  }

  // Derived fields — the template engine doesn't loop or branch, so
  // structured values become prebuilt HTML the template includes raw.
  //
  // 'icon': `{name}_svg` — inline SVG for known CORE_ICONS names, the
  // HTML-escaped raw value otherwise (emoji/text stand-ins keep working).
  //
  // 'choices' (form/* blocks): `{name}_options_html` — <option> rows or
  // radio/checkbox <label> rows per FieldDefinition.choices_markup. Input
  // name comes from the block's own `name` field; everything is escaped
  // here, so the raw {{{…}}} token is injection-safe.
  for (const field of blockType.schema ?? []) {
    if (field.type === 'icon') {
      compiled.flatData[`${field.name}_svg`] = renderIconHtml(
        String(compiled.flatData[field.name] ?? ''),
      );
    }
    if (field.type === 'choices') {
      compiled.flatData[`${field.name}_options_html`] = renderChoicesHtml(
        effectiveBlock.data?.[field.name],
        field.choices_markup ?? 'select',
        String(effectiveBlock.data?.name ?? ''),
      );
    }
  }

  let html = substituteFields(template, compiled.flatData, options.context);
  html = substituteChildren(html, effectiveBlock, options);
  html = substituteSlots(html, effectiveBlock, blockType, options);

  // Inject responsive / visibility attributes onto the outermost element.
  // Both rely on the block's id being CSS-safe (alphanumeric + _ + -);
  // sanitizeCssId() escapes anything else.
  const bid = sanitizeCssId(effectiveBlock.id);
  const rootAttrs: Record<string, string> = {};
  // data-bid is normally only needed when responsive overrides target it —
  // but an instance script's IIFE resolves its own element by this selector,
  // so a block carrying code in a declared script_field needs it too or its
  // JS silently no-ops on the published site.
  const carriesInstanceScript = (blockType.script_fields ?? []).some((f) => {
    const v = effectiveBlock.data?.[f];
    return typeof v === 'string' && v.trim() !== '';
  });
  if (compiled.hasOverrides || carriesInstanceScript) rootAttrs['data-bid'] = bid;
  // Block provenance — lets an agent map the rendered element back to the
  // authored block it should edit. Uses the original (pre-alias-expansion)
  // id + type so it matches what get_page_blocks returns.
  if (options.annotate && block.id) {
    rootAttrs['data-block-id'] = block.id;
    rootAttrs['data-block-type'] = block.type;
  } else if (blockType.script) {
    // Script-bearing blocks ALWAYS need the type attribute — it's the
    // selector the client runtime's init() uses to find instances
    // (window.TyperollBlocks.register(id, …) → querySelectorAll on
    // [data-block-type=id]). Without this, scripted blocks initialized in
    // the editor preview (annotate on) but were DEAD on deployed sites.
    // Uses the resolved type id: that's the id the script registers under
    // (aliases run the target's script).
    rootAttrs['data-block-type'] = blockType.id;
  }
  if (blockType.extension) {
    // Extension values are identifiers and public block props only. Dynamic
    // URL context is captured later by the browser host and is never written
    // into this markup or the static build snapshot.
    rootAttrs['data-tr-extension'] = blockType.extension.extension_id;
    rootAttrs['data-tr-extension-installation'] = blockType.extension.installation_id;
    rootAttrs['data-tr-extension-component'] = blockType.extension.component_id;
    rootAttrs['data-block-data'] = JSON.stringify(effectiveBlock.data ?? {});
  }
  if (effectiveBlock.hidden_on?.length) {
    for (const bp of effectiveBlock.hidden_on) {
      rootAttrs[`data-hidden-${bp}`] = '';
    }
  }
  if (Object.keys(rootAttrs).length > 0) {
    html = injectAttrsIntoFirstTag(html, rootAttrs);
  }

  // Append a per-instance <style> block for responsive CSS variable
  // overrides. Mobile baseline values are already in the substituted
  // template; the style block only carries @media overrides for
  // breakpoints above mobile.
  if (compiled.hasOverrides) {
    html += renderResponsiveStyleBlock(bid, compiled.cssVars, compiled.mappedCss);
  }

  html = applyStyleOverrides(html, effectiveBlock);

  return html;
}

/**
 * Render a repeater block. Loops over the resolved item list and renders
 * each item via the configured `item_block` BlockType. Item data is
 * supplied either statically (`source_type: 'static'`) or by the caller's
 * `collectionSource` resolver for collection-backed repeaters.
 *
 * Layout shell:
 *   - `grid`     — flex/grid wrap with `--cols` + `--gap`
 *   - `list`     — vertical stack
 *   - `carousel` — horizontal scroll-snap container (CSS-only; the alias
 *     blocks can layer in JS controls via their own scripts)
 *   - `stack`    — inline-flex row
 *   - `masonry`  — CSS columns (good enough for image galleries)
 *   - `justified` — same as grid but with `auto-fit`
 *
 * The shell is rendered by the repeater itself; each item is rendered
 * standalone via `renderBlock`. Item-compatible blocks already have the
 * right layout shape (no outer padding/section), so they tile cleanly.
 */
function renderRepeater(
  block: Block,
  blockType: BlockType,
  options: RenderBlocksOptions,
): string {
  const data = block.data ?? {};
  const sourceType = (data.source_type as string) || 'static';
  const itemBlockId = String(data.item_block ?? '');
  const itemBlockType = itemBlockId ? getRegistryEntry(options.registry, itemBlockId) : undefined;

  if (!itemBlockType) {
    return `<!-- repeater missing item_block: ${escapeHtml(itemBlockId)} -->`;
  }

  // Resolve items: static array from data, or external collection source.
  let items: Record<string, unknown>[] = [];
  if (sourceType === 'static') {
    const raw = data.items;
    if (Array.isArray(raw)) {
      items = raw.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
    }
  } else if (sourceType === 'collection') {
    if (!options.collectionSource) {
      return `<!-- repeater needs a collectionSource for collection-backed sources -->`;
    }
    const perPage = typeof data.paginate === 'number' && data.paginate > 0
      ? Math.floor(data.paginate) : 0;
    // Inherit the page's taxonomy scope when the block declares no filter of
    // its own. Only the first filter is applied here; a combination page
    // narrows the rest below, since collectionSource takes a single pair.
    const inherited = options.context?.facet?.filters?.[0];
    const filterField = typeof data.filter_field === 'string' && data.filter_field
      ? data.filter_field : inherited?.field;
    const filterValue = typeof data.filter_value === 'string' && data.filter_value !== undefined
      ? data.filter_value : inherited?.value;
    items = options.collectionSource({
      collection: String(data.collection ?? ''),
      // paginate supersedes limit: the archive owns the full item list and
      // slices per page; a limit would silently cap the archive.
      limit: perPage > 0 ? undefined : (typeof data.limit === 'number' ? data.limit : undefined),
      sort_by: typeof data.sort_by === 'string' ? data.sort_by : undefined,
      sort_order: data.sort_order === 'asc' || data.sort_order === 'desc' ? data.sort_order : undefined,
      filter_field: filterField,
      filter_value: filterValue,
      pinned_ids: Array.isArray(data.pinned_ids) ? (data.pinned_ids as string[]) : undefined,
    });
    // A combination page carries more than one filter; apply the remainder
    // in-process rather than widening the source contract for a rare shape.
    for (const extra of (options.context?.facet?.filters ?? []).slice(1)) {
      items = items.filter((it) => {
        const v = (it as Record<string, unknown>)[extra.field];
        return Array.isArray(v) ? v.includes(extra.value) : String(v ?? '') === extra.value;
      });
    }
    if (perPage > 0) {
      const current = Math.max(1, options.context?.pagination?.current ?? 1);
      const totalPages = Math.max(1, Math.ceil(items.length / perPage));
      const baseUrl = options.context?.pagination?.base_url ?? '';
      items = items.slice((current - 1) * perPage, current * perPage);
      const pager = totalPages > 1
        ? renderPager(current, totalPages, baseUrl, options.context?.pagination?.trailing_slash)
        : '';
      return renderRepeaterItems(block, blockType, itemBlockType, data, items, options) + pager;
    }
  } else if (sourceType === 'related' || sourceType === 'backlinks') {
    // Reference-driven sources. Both reduce to "render exactly this list of
    // ids from that collection"; they differ only in where the ids come from
    // — a ref field on the current item, or the computed reverse index.
    if (!options.collectionSource) {
      return `<!-- repeater needs a collectionSource for reference-backed sources -->`;
    }
    const ctxItem = options.context?.item as Record<string, unknown> | undefined;
    // `collection` names where the RENDERED items live. For `related` that's
    // the ref field's target; for `backlinks` it's the collection doing the
    // referencing (articles pointing at this company), which is also what
    // narrows a multi-collection backlink list down to one renderable shape.
    const target = String(data.collection ?? '');
    let ids: string[] = [];
    if (sourceType === 'related') {
      const fieldName = String(data.field ?? '');
      if (!fieldName) return `<!-- related repeater needs a \`field\` naming the ref field -->`;
      // After expandItemRefs a single ref holds the resolved object and the
      // raw id moves to `{field}_id`; list refs keep their ids in place.
      ids = refIds(ctxItem?.[fieldName]);
      if (ids.length === 0) ids = refIds(ctxItem?.[`${fieldName}_id`]);
    } else {
      const currentId = typeof ctxItem?.id === 'string' ? ctxItem.id : '';
      const currentCollection = String(options.context?.collection?.name ?? '');
      ids = currentId && options.context?.backlinks
        ? backlinksFor(options.context.backlinks, currentCollection, currentId, target || undefined)
            .map((b) => b.id)
        : [];
    }
    if (ids.length === 0 || !target) return '';
    const cap = typeof data.limit === 'number' && data.limit > 0 ? data.limit : undefined;
    items = options.collectionSource({
      collection: target,
      ids: cap ? ids.slice(0, cap) : ids,
    });
  } else if (sourceType === 'children_blocks') {
    // Render each direct child block as one repeater item, preserving the
    // child's authored block type. Useful for "I want each item to be a
    // different block type" cases.
    const children = block.children ?? [];
    const inner = children.map((c) => renderBlock(c, options)).join('');
    return wrapRepeater(block, blockType, data, inner);
  }

  return renderRepeaterItems(block, blockType, itemBlockType, data, items, options);
}

/** Render a repeater's resolved items into the layout shell. Shared by the
 *  plain path and the paginated path (which slices items first and appends
 *  a pager after the shell). */
function renderRepeaterItems(
  block: Block,
  blockType: BlockType,
  itemBlockType: BlockType,
  data: Record<string, unknown>,
  items: Record<string, unknown>[],
  options: RenderBlocksOptions,
): string {
  const overrides = (data.item_overrides as Record<string, unknown> | undefined) ?? {};
  // For each iteration, push the current item into the render context so
  // the item template can reference `{{item.title}}`, `{{item.url}}` etc.
  // The collection name flows along too for `{{collection.name}}`.
  const collectionName = String(data.collection ?? '');
  const renderItems = (source: Record<string, unknown>[], offset = 0) => source
    .map((item, i) => {
      const itemBlock: Block = {
        id: `${block.id}__i${offset + i}`,
        type: itemBlockType.id,
        // Item data takes precedence over the repeater's defaults; the
        // overrides win over BOTH (use this to lock heading levels etc.
        // regardless of item data).
        data: { ...item, ...overrides },
      };
      const iterOptions: RenderBlocksOptions = {
        ...options,
        context: {
          ...options.context,
          item,
          collection: collectionName
            ? { name: collectionName, ...(options.context?.collection ?? {}) }
            : options.context?.collection,
        },
      };
      return renderBlock(itemBlock, iterOptions);
    })
    .join('');

  if (items.length === 0 && data.empty_state) {
    return wrapRepeater(block, blockType, data, escapeHtml(data.empty_state));
  }

  const groupBy = typeof data.group_by === 'string' ? data.group_by.trim() : '';
  if (!groupBy) return wrapRepeater(block, blockType, data, renderItems(items));

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const raw = item[groupBy];
    const labels = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
    for (const candidate of labels.length ? labels : ['']) {
      const label = candidate.trim() || String(data.ungrouped_label ?? 'Other');
      const group = groups.get(label) ?? [];
      group.push(item);
      groups.set(label, group);
    }
  }
  const direction = data.group_sort_order === 'desc' ? -1 : 1;
  const level = ['h2', 'h3', 'h4'].includes(String(data.group_heading_level))
    ? String(data.group_heading_level) : 'h2';
  let offset = 0;
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }) * direction)
    .map(([label, group]) => {
      const inner = renderItems(group, offset);
      offset += group.length;
      return `<section class="tr-repeater-group" data-repeater-group="${escapeHtml(label)}"><${level} class="tr-repeater-group-title">${escapeHtml(label)}</${level}>${wrapRepeater(block, blockType, data, inner)}</section>`;
    })
    .join('');
}

/** Archive pager: prev/next + numbered links. Page 1 is the page's own
 *  URL, page N lives at `${base}page/N/`. rel=prev/next help crawlers walk
 *  the archive even though paged routes stay out of the sitemap. */
function renderPager(
  current: number,
  totalPages: number,
  baseUrl: string,
  trailingSlash: TrailingSlashPolicy = 'always',
): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const urlFor = (n: number) => applyTrailingSlash(n <= 1 ? base : `${base}page/${n}`, trailingSlash);
  const link = (n: number, label: string, rel?: string, current_ = false) =>
    current_
      ? `<span class="tr-pager-current" aria-current="page">${label}</span>`
      : `<a href="${escapeHtml(urlFor(n))}"${rel ? ` rel="${rel}"` : ''}>${label}</a>`;

  const parts: string[] = [];
  if (current > 1) parts.push(link(current - 1, '‹', 'prev'));
  for (let n = 1; n <= totalPages; n++) {
    // Compact windows on long archives: 1 … c-1 c c+1 … N
    if (totalPages > 7 && n !== 1 && n !== totalPages && Math.abs(n - current) > 1) {
      if (n === 2 || n === totalPages - 1) parts.push('<span class="tr-pager-gap">…</span>');
      continue;
    }
    parts.push(link(n, String(n), undefined, n === current));
  }
  if (current < totalPages) parts.push(link(current + 1, '›', 'next'));

  return `<nav data-block="pager" class="tr-pager" aria-label="Pagination">${parts.join('')}</nav>`;
}

/**
 * Wrap the rendered items in a layout shell. Single function so the
 * static / collection / children_blocks branches share the same layout
 * logic.
 */
function wrapRepeater(
  block: Block,
  _blockType: BlockType,
  data: Record<string, unknown>,
  inner: string,
): string {
  const bid = sanitizeCssId(block.id);
  const layout = String(data.layout ?? 'grid');
  const cols = String(data.cols ?? 3);
  const gap = String(data.gap ?? 'md');
  const align = String(data.align ?? 'stretch');

  // The repeater's own outer element. Tier 1 grid styles map --cols → grid;
  // the additional layouts (list, carousel, stack, masonry) get inline
  // CSS classes that the runtime CSS bundle styles.
  return `<div data-block="repeater" data-bid="${bid}" data-layout="${escapeHtml(layout)}" style="--cols:${escapeHtml(cols)};--gap:${escapeHtml(gap)};--align:${escapeHtml(align)}">${inner}</div>`;
}

/**
 * The `site` slice of a RenderContext, built from the SiteSettings doc.
 *
 * Exists for one reason: **`{{site.name}}` is the documented token and
 * `SiteSettings` has no `name` field — it has `site_name`.** Every caller
 * previously passed the settings doc verbatim, so `template/site_title`
 * rendered an empty heading and `template/site_logo` an empty `alt`, on the
 * live site and in the portal preview alike. Nothing failed; the text was
 * just missing.
 *
 * Both renderers must build the context the same way or they drift, which is
 * exactly the class of bug this fixes — so the mapping lives here, in the
 * package they share, rather than being repeated at each call site.
 *
 * `site_name` stays reachable too: a site that already worked around this
 * with `{{site.site_name}}` keeps working.
 */
export function siteContext(
  settings: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const s = settings ?? {};
  return { ...s, name: s.site_name ?? s.name ?? '' };
}

/**
 * Render an ordered list of blocks (e.g. a page's top-level `blocks`, or one
 * slot's contents).
 */
export function renderBlocks(blocks: Block[], options: RenderBlocksOptions): string {
  return blocks.map((b) => renderBlock(b, options)).join('');
}

const TEMPLATE_SLOT_ID = 'template_content_slot';

/**
 * Compose a page template with a page's blocks. Replaces every
 * `template_content_slot` block in the template's tree with the page's
 * own `blocks` (inline expansion — the slot block itself disappears and
 * is replaced by the page blocks at that position).
 *
 * If the template has no slot, the page blocks render after the template
 * tree as a fallback so content isn't silently dropped on a misconfigured
 * template.
 *
 * Returns a new tree; inputs are not mutated.
 */
export function composePageWithTemplate(
  templateBlocks: Block[],
  pageBlocks: Block[],
): Block[] {
  let foundSlot = false;
  function walk(list: Block[]): Block[] {
    const out: Block[] = [];
    for (const b of list) {
      if (b.type === TEMPLATE_SLOT_ID) {
        foundSlot = true;
        out.push(...pageBlocks);
        continue;
      }
      const next: Block = { ...b };
      if (b.children?.length) next.children = walk(b.children);
      if (b.slots?.length) next.slots = b.slots.map((slot) => walk(slot));
      out.push(next);
    }
    return out;
  }
  const composed = walk(templateBlocks);
  if (!foundSlot) {
    // Template forgot to declare a slot — append page blocks at the end
    // rather than dropping them silently. Render logs (caller's
    // responsibility) should surface this.
    composed.push(...pageBlocks);
  }
  return composed;
}

function defaultMissingType(typeId: string, _block: Block): string {
  return `<!-- unknown block type: ${escapeHtml(typeId)} -->`;
}

/**
 * Allowlist of HTML tag names that the {{=field}} tag-substitution may
 * resolve to. Anything outside this set falls back to `div`. The list is
 * intentionally narrow — semantic elements only, no media or interactive
 * tags. Adding to this list is a deliberate decision (security review).
 */
const SAFE_TAG_NAMES = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'span',
  'section', 'article', 'aside', 'nav',
  'header', 'footer', 'main',
  'figure', 'figcaption',
  'blockquote', 'cite', 'em', 'strong', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
]);

/**
 * Resolve a dotted-path token (`page.title`, `item.author.name`) against
 * the render context. Walks `.`-separated segments; returns `undefined`
 * if any segment is missing. The first segment must match a context
 * namespace (`page` / `site` / `item` / `collection`) — anything else
 * falls back to the block-local data lookup.
 */
function resolveDottedToken(
  name: string,
  data: Record<string, unknown>,
  context: RenderContext | undefined,
): unknown {
  if (!name.includes('.')) return data[name];
  const [head, ...rest] = name.split('.');
  const root: Record<string, unknown> | undefined = (() => {
    switch (head) {
      case 'page':       return context?.page;
      case 'site':       return context?.site;
      case 'item':       return context?.item;
      case 'collection': return context?.collection;
      default:           return data[head!] as Record<string, unknown> | undefined;
    }
  })();
  if (!root || typeof root !== 'object') return undefined;
  let cur: unknown = root;
  for (const seg of rest) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** True when `index` into `s` falls inside an HTML tag (between < and >). */
function insideTag(s: string, index: number): boolean {
  const lastLt = s.lastIndexOf('<', index);
  const lastGt = s.lastIndexOf('>', index);
  return lastLt > lastGt;
}

/**
 * Wrap text-context `{{field}}` tokens of plain-text schema fields in an
 * inline-edit marker span. Attribute-context tokens (href, style vars) are
 * left alone — insideTag() guards them — as are triple-brace raw tokens
 * (the brace-neighbor check) and fields whose stored value carries a
 * `{{…}}` context binding (their rendered text differs from the stored
 * value, so a text edit couldn't round-trip).
 */
function stampEditableTextTokens(
  template: string,
  blockType: BlockType,
  block: Block,
  blockId: string,
): string {
  let out = template;
  for (const field of blockType.schema ?? []) {
    if (field.type !== 'text') continue;
    const raw = block.data?.[field.name];
    if (typeof raw === 'string' && raw.includes('{{')) continue;
    const src = out;
    const re = new RegExp(`\\{\\{\\s*${field.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
    out = src.replace(re, (m, offset: number) => {
      // Part of a {{{raw}}} token or inside a tag → leave untouched.
      if (src[offset - 1] === '{' || src[offset + m.length] === '}') return m;
      if (insideTag(src, offset)) return m;
      return `<span data-edit="${escapeHtml(blockId)}:${field.name}" data-edit-kind="text">${m}</span>`;
    });
  }
  return out;
}

function substituteFields(
  template: string,
  data: Record<string, unknown>,
  context?: RenderContext,
): string {
  // {{{field}}} — raw. Must be matched BEFORE the escaped variant or the
  // double-brace regex eats the leading brace of a triple-brace token.
  let out = template.replace(/\{\{\{\s*([\w.-]+)\s*\}\}\}/g, (_m, name: string) => {
    const v = resolveDottedToken(name, data, context);
    return v == null ? '' : String(v);
  });
  // {{=field}} — HTML tag-name substitution. Validates against SAFE_TAG_NAMES;
  // unknown values become `div`. Run BEFORE the plain {{field}} pass so the
  // `=` prefix is consumed and doesn't fall through.
  out = out.replace(/\{\{=\s*([\w.-]+)\s*\}\}/g, (_m, name: string) => {
    const v = String(resolveDottedToken(name, data, context) ?? '').trim().toLowerCase();
    return SAFE_TAG_NAMES.has(v) ? v : 'div';
  });
  out = out.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name: string) => {
    // Reserved tokens that have their own substitution pass — leave them
    // alone here so the next pass can handle them.
    if (name === 'children') return m;
    if (name.startsWith('slot:')) return m;
    return escapeHtml(resolveDottedToken(name, data, context));
  });
  return out;
}

function renderBreadcrumbs(raw: unknown, homeLabel: string): string {
  const candidates = Array.isArray(raw) ? raw : [];
  const crumbs: Array<{ label: string; href: string; current: boolean }> = [
    { label: homeLabel, href: '/', current: false },
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    const label = String(item.label ?? '').trim();
    if (!label) continue;
    crumbs.push({
      label,
      href: typeof item.href === 'string' ? item.href : '',
      current: item.current === true,
    });
  }
  return `<ol>${crumbs.map((crumb, index) => {
    const current = crumb.current || index === crumbs.length - 1 || !crumb.href;
    return current
      ? `<li><span aria-current="page">${escapeHtml(crumb.label)}</span></li>`
      : `<li><a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a></li>`;
  }).join('')}</ol>`;
}

function navigationLinkData(
  direction: 'previous' | 'next',
  data: Record<string, unknown>,
  item: Record<string, unknown>,
  collection: Record<string, unknown>,
): { url: string; title: string } {
  const explicitUrlField = String(data[`${direction}_url_field`] ?? '').trim();
  const explicitTitleField = String(data[`${direction}_title_field`] ?? '').trim();
  const sorted = collection[direction] && typeof collection[direction] === 'object'
    ? collection[direction] as Record<string, unknown>
    : {};
  const url = explicitUrlField
    ? String(item[explicitUrlField] ?? '')
    : String(sorted.url ?? '');
  const title = explicitTitleField
    ? String(item[explicitTitleField] ?? '')
    : String(sorted.title ?? '');
  return { url, title };
}

function contextString(
  data: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  valueKey: string,
  fieldKey: string,
  fallbackField: string,
): string {
  const selectedField = String(data[fieldKey] ?? fallbackField).trim();
  const selected = item && selectedField ? item[selectedField] : undefined;
  const value = selected ?? data[valueKey];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function preparePostCardData(
  data: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): void {
  const title = contextString(data, item, 'title', 'title_field', 'title');
  const excerpt = contextString(data, item, 'excerpt', 'excerpt_field', 'excerpt');
  const image = contextString(data, item, 'image', 'image_field', 'image');
  const imageAlt = contextString(data, item, 'image_alt', 'image_alt_field', 'image_alt');
  const date = contextString(data, item, 'date', 'date_field', 'published_at');
  const author = contextString(data, item, 'author', 'author_field', 'author');
  const href = contextString(data, item, 'href', 'href_field', 'url');
  const downloadField = String(data.download_url_field ?? '').trim();
  const downloadUrl = item && downloadField ? String(item[downloadField] ?? '') : '';
  const downloadLabel = String(data.download_label ?? 'Download PDF');
  const headingLevel = ['h2', 'h3', 'h4'].includes(String(data.heading_level))
    ? String(data.heading_level) : 'h3';

  data.title = title;
  data.excerpt = excerpt;
  data.date = date;
  data.author = author;
  data.href = href;
  data.heading_level = headingLevel;
  data.post_card_title_html = href
    ? `<a href="${escapeHtml(href)}" class="block-postcard-link">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  data.post_card_image_html = data.show_image !== false && image
    ? `${href ? `<a href="${escapeHtml(href)}" class="block-postcard-link">` : ''}<img class="block-postcard-image" src="${escapeHtml(image)}" alt="${escapeHtml(imageAlt)}" loading="lazy" decoding="async" />${href ? '</a>' : ''}`
    : '';
  data.post_card_download_html = downloadUrl
    ? `<a class="block-postcard-download" href="${escapeHtml(downloadUrl)}">${escapeHtml(downloadLabel)}</a>`
    : '';
}

function renderNavigationLinks(
  raw: unknown,
  page: Record<string, unknown> | undefined,
): string {
  if (!Array.isArray(raw)) return '';
  const currentRaw = String(page?.path ?? page?.url ?? page?.slug ?? '/');
  const normalize = (value: string) => {
    try {
      const path = new URL(value, 'https://typeroll.invalid').pathname;
      return path === '/' ? '/' : path.replace(/\/+$/, '');
    } catch {
      return value === '/' ? '/' : value.replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
  };
  const current = normalize(currentRaw.startsWith('/') ? currentRaw : `/${currentRaw}`);
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => {
      const label = String(entry.label ?? '').trim();
      const href = String(entry.href ?? '').trim();
      if (!label || !href) return '';
      const ariaCurrent = normalize(href) === current ? ' aria-current="page"' : '';
      return `<li><a href="${escapeHtml(href)}"${ariaCurrent}>${escapeHtml(label)}</a></li>`;
    })
    .join('');
}

function substituteChildren(
  html: string,
  block: Block,
  options: RenderBlocksOptions,
): string {
  if (!html.includes('{{children}}')) return html;
  const inner = block.children ? renderBlocks(block.children, options) : '';
  return html.split('{{children}}').join(inner);
}

function substituteSlots(
  html: string,
  block: Block,
  blockType: BlockType,
  options: RenderBlocksOptions,
): string {
  if (!html.includes('{{slot:')) return html;
  return html.replace(/\{\{\s*slot:([\w-]+)\s*\}\}/g, (_m, ref: string) => {
    const slotIndex = resolveSlotIndex(ref, blockType);
    if (slotIndex < 0) return '';
    const slot = block.slots?.[slotIndex];
    return slot ? renderBlocks(slot, options) : '';
  });
}

function resolveSlotIndex(ref: string, blockType: BlockType): number {
  // Numeric reference: slot:0, slot:1
  const asNumber = Number(ref);
  if (Number.isInteger(asNumber)) return asNumber;
  // Label reference: slot:left → find in slot_labels (case-insensitive)
  const labels = blockType.slot_labels ?? [];
  const idx = labels.findIndex((l) => l.toLowerCase() === ref.toLowerCase());
  return idx;
}

/**
 * Apply Block.style_overrides as a wrapping span/div with inline style. The
 * renderer only handles spacing + custom_class + html_id here — `custom_css`
 * is a separate per-block stylesheet concern and is collected by the build
 * pipeline, not inlined per-element.
 */
/** Build the markup a 'choices' field derives ({name}_options_html). */
function renderChoicesHtml(
  raw: unknown,
  markup: 'select' | 'radio' | 'checkbox',
  inputName: string,
): string {
  if (!Array.isArray(raw)) return '';
  const items = raw.filter(
    (x): x is { value?: unknown; label?: unknown } => x !== null && typeof x === 'object',
  );
  const esc = escapeHtml;
  if (markup === 'select') {
    const placeholder = '<option value="" disabled selected hidden></option>';
    return (
      placeholder +
      items
        .map((c) => `<option value="${esc(String(c.value ?? c.label ?? ''))}">${esc(String(c.label ?? c.value ?? ''))}</option>`)
        .join('')
    );
  }
  const type = markup; // 'radio' | 'checkbox'
  return items
    .map(
      (c) =>
        `<label class="form-choice"><input type="${type}" name="${esc(inputName)}" value="${esc(String(c.value ?? c.label ?? ''))}" /><span>${esc(String(c.label ?? c.value ?? ''))}</span></label>`,
    )
    .join('\n');
}

function applyStyleOverrides(html: string, block: Block): string {
  const so = block.style_overrides;
  if (!so) return html;

  const inlineStyleParts: string[] = [];
  if (so.spacing_before) inlineStyleParts.push(`margin-top:${cssValue(so.spacing_before)}`);
  if (so.spacing_after) inlineStyleParts.push(`margin-bottom:${cssValue(so.spacing_after)}`);

  if (inlineStyleParts.length === 0 && !so.custom_class && !so.html_id) {
    return html;
  }

  // Merge into the block's own root element when possible. A wrapper <div>
  // changes layout semantics: the full-bleed shell matches direct
  // `<section>` children of the page container, so a section wrapped for
  // the sake of an anchor id or custom class silently loses full-bleed
  // (and picks up the constrained-child margins). Wrapping remains the
  // fallback for templates whose root tag can't be merged into safely.
  const merged = mergeAttrsIntoFirstTag(html, {
    id: so.html_id,
    class: so.custom_class,
    style: inlineStyleParts.length > 0 ? inlineStyleParts.join(';') : undefined,
  });
  if (merged !== null) return merged;

  const attrs: string[] = [];
  if (so.html_id) attrs.push(`id="${escapeHtml(so.html_id)}"`);
  if (so.custom_class) attrs.push(`class="${escapeHtml(so.custom_class)}"`);
  if (inlineStyleParts.length > 0) attrs.push(`style="${escapeHtml(inlineStyleParts.join(';'))}"`);

  return `<div ${attrs.join(' ')}>${html}</div>`;
}

/**
 * Merge id/class/style into the first opening tag of `html`. Unlike
 * injectAttrsIntoFirstTag (which skips already-present attributes),
 * `class` and `style` are APPENDED to existing double-quoted values.
 * Returns null — caller falls back to wrapping — when the html doesn't
 * start with a parseable opening tag, when the root already has an `id`
 * (an author-set id wins; the override must not be dropped), or when an
 * existing class/style attribute isn't double-quoted.
 */
function mergeAttrsIntoFirstTag(
  html: string,
  attrs: { id?: string; class?: string; style?: string },
): string | null {
  const FIRST_TAG_RE = /^(<[a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\s*\/?>)/;
  const m = html.match(FIRST_TAG_RE);
  if (!m) return null;
  let existing = m[2] ?? '';

  if (attrs.id) {
    if (/\sid\s*=/.test(existing)) return null;
    existing += ` id="${escapeHtml(attrs.id)}"`;
  }
  if (attrs.class) {
    if (/\sclass\s*=/.test(existing)) {
      const re = /(\sclass\s*=\s*")([^"]*)(")/;
      if (!re.test(existing)) return null;
      existing = existing.replace(re, (_cm, p1, p2, p3) => `${p1}${p2} ${escapeHtml(attrs.class!)}${p3}`);
    } else {
      existing += ` class="${escapeHtml(attrs.class)}"`;
    }
  }
  if (attrs.style) {
    if (/\sstyle\s*=/.test(existing)) {
      const re = /(\sstyle\s*=\s*")([^"]*)(")/;
      if (!re.test(existing)) return null;
      existing = existing.replace(re, (_cm, p1, p2: string, p3) => {
        const sep = p2 && !p2.trimEnd().endsWith(';') ? ';' : '';
        return `${p1}${p2}${sep}${escapeHtml(attrs.style!)}${p3}`;
      });
    } else {
      existing += ` style="${escapeHtml(attrs.style)}"`;
    }
  }

  return html.replace(FIRST_TAG_RE, (_m2, open, _ex, close) => `${open}${existing}${close}`);
}

/**
 * Tiny condition evaluator for `container: 'conditional'` blocks. Keeps
 * the surface area small on purpose — no `eval`, no arbitrary JS. Supports:
 *
 *   - Bare identifier (truthy check):   `page.featured_image`
 *   - Negation:                          `!page.draft`
 *   - String equality:                   `page.category === "blog"`
 *   - String inequality:                 `page.status !== "draft"`
 *   - Boolean &&, ||:                    `page.show_hero && !item.archived`
 *
 * Tokens with dotted paths resolve against the render context (page /
 * site / item / collection) or block-local data. Any unrecognised
 * expression returns `false` — a misconfigured conditional fails closed
 * (block doesn't render) rather than rendering on every page.
 */
function evaluateCondition(
  expr: string,
  context: RenderContext | undefined,
  data: Record<string, unknown>,
): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;

  // Split on `||` first (lowest precedence), then `&&` per group.
  const orGroups = splitTopLevel(trimmed, '||');
  for (const orGroup of orGroups) {
    const andTerms = splitTopLevel(orGroup, '&&');
    const allTrue = andTerms.every((t) => evaluateTerm(t.trim(), context, data));
    if (allTrue) return true;
  }
  return false;
}

function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && input.startsWith(sep, i)) {
      out.push(input.slice(last, i));
      i += sep.length - 1;
      last = i + 1;
    }
  }
  out.push(input.slice(last));
  return out;
}

function evaluateTerm(
  term: string,
  context: RenderContext | undefined,
  data: Record<string, unknown>,
): boolean {
  // Negation
  if (term.startsWith('!')) {
    return !evaluateTerm(term.slice(1).trim(), context, data);
  }
  // Equality comparison
  const eqMatch = term.match(/^([\w.-]+)\s*(===|!==)\s*(?:"([^"]*)"|'([^']*)'|(\d+))$/);
  if (eqMatch) {
    const [, path, op, dq, sq, num] = eqMatch;
    const lhs = resolveDottedToken(path!, data, context);
    const rhs = dq ?? sq ?? (num != null ? Number(num) : undefined);
    return op === '===' ? lhs === rhs : lhs !== rhs;
  }
  // Bare truthy check
  if (/^[\w.-]+$/.test(term)) {
    const v = resolveDottedToken(term, data, context);
    return !!v;
  }
  // Unknown shape — fail closed
  return false;
}

function cssValue(v: string): string {
  // Reject anything that looks like CSS injection (semicolons, braces, urls).
  if (/[;{}()<>]/.test(v)) return '';
  return v;
}

/**
 * Per-block CSS-variable value sanitiser. Allows the printable subset that
 * shows up in real design values — alphanumerics, dots/percentages/units,
 * commas, spaces, parentheses (for `clamp(`, `var(`, `rgb(`), hex colors,
 * and the minus sign. Rejects anything with semicolons, braces, quotes, or
 * angle brackets that could break out of the rule.
 */
function sanitizeCssVarValue(v: string): string {
  if (/[;{}<>"]/.test(v)) return '';
  return v;
}

/**
 * Sanitize a CSS *declaration* string (`prop: value; …`) from a field's
 * `responsive_css` map before injecting it into a per-instance <style>.
 * Unlike a single var value, declarations legitimately contain `:` and `;`,
 * so we can't reuse sanitizeCssVarValue. We reject anything that could break
 * out of the rule or open a new at-rule (`{ } < > " @`) and fall back to an
 * empty string. Field schemas can be author-controlled (custom block types),
 * so this is a security boundary, not just tidiness.
 */
function sanitizeCssDeclarations(s: string): string {
  if (/[{}<>"@]/.test(s)) return '';
  return s.trim();
}

/**
 * Strip block.id to a CSS-attribute-safe slug. Block IDs in this codebase
 * are normally `blk_<random>` / `b_<random>` which are already safe, but
 * we defensively clamp anything weird.
 */
function sanitizeCssId(id: string | undefined | null): string {
  // Defensive: hand-authored trees have reached the renderer without ids
  // (write paths now normalise via ensureBlockIds, but the renderer must
  // never 500 a whole page over one malformed block). An empty bid just
  // means per-instance responsive styles can't target this block.
  return (id ?? '').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

/**
 * Per-field responsive resolver. For each field marked `responsive: true`
 * in the BlockType schema whose data is a per-breakpoint object, the
 * mobile value flows into `flatData` (so existing `{{field}}` substitutions
 * just work), and the breakpoint deltas are collected as CSS variable
 * overrides keyed by breakpoint.
 *
 * **Convention** for templates: expose responsive fields as CSS variables
 * with name `--{field-name}` on the outermost block element via
 * `style="--field-name:{{field-name}}"`. The @media overrides target the
 * same variable. Block CSS reads `var(--field-name)` to apply the value.
 */
interface ResponsiveCompileResult {
  flatData: Record<string, unknown>;
  cssVars: Partial<Record<Breakpoint, Record<string, string>>>;
  /** Raw CSS declaration strings per breakpoint, from a field's
   *  `responsive_css` token map (token isn't a usable CSS value). */
  mappedCss: Partial<Record<Breakpoint, string>>;
  hasOverrides: boolean;
}

function compileResponsiveData(
  block: Block,
  blockType: BlockType,
): ResponsiveCompileResult {
  const data = block.data ?? {};
  const flatData: Record<string, unknown> = { ...data };
  const cssVars: Partial<Record<Breakpoint, Record<string, string>>> = {};
  const mappedCss: Partial<Record<Breakpoint, string>> = {};
  let hasOverrides = false;

  const bps: Breakpoint[] = ['mobile', 'tablet', 'laptop', 'desktop', 'wide'];
  const responsiveFields = (blockType.schema ?? []).filter(
    (f: FieldDefinition) => f.responsive,
  );
  for (const field of responsiveFields) {
    const raw = data[field.name];
    if (!isResponsiveValue(raw)) continue;

    // Token field with a CSS map: the value (e.g. 'icon-left') isn't usable
    // CSS, so emit the MAPPED declarations per breakpoint instead of the raw
    // --{field} var. The mobile baseline is still surfaced inline so the
    // block's own baseline rule handles it; only the deltas need overriding.
    if (field.responsive_css) {
      let prevTok: unknown = undefined;
      for (const bp of bps) {
        const v = resolveResponsive(raw as never, bp);
        if (v === undefined) continue;
        if (bp === 'mobile') {
          flatData[field.name] = v;
        } else if (v !== prevTok) {
          const decls = sanitizeCssDeclarations(field.responsive_css[String(v)] ?? '');
          if (decls) {
            mappedCss[bp] = (mappedCss[bp] ?? '') + decls;
            hasOverrides = true;
          }
        }
        prevTok = v;
      }
      continue;
    }

    // Resolve baseline (mobile) and emit deltas for each larger BP.
    let prev: unknown = undefined;
    for (const bp of bps) {
      const v = resolveResponsive(raw as never, bp);
      if (v === undefined) continue;
      if (bp === 'mobile') {
        flatData[field.name] = v;
      } else if (v !== prev) {
        const safe = sanitizeCssVarValue(String(v));
        if (safe) {
          (cssVars[bp] ??= {})[field.name] = safe;
          hasOverrides = true;
        }
      }
      prev = v;
    }
  }

  return { flatData, cssVars, mappedCss, hasOverrides };
}

/**
 * Inject HTML attributes into the first opening tag of `html`. Existing
 * attributes with the same name are left alone (the renderer doesn't
 * overwrite author intent). Used for `data-bid` and `data-hidden-{bp}`.
 *
 * Templates are expected to begin with the outermost element directly
 * (no leading whitespace or comments). The Tier 1 + core templates all
 * follow this; if a template doesn't, the attribute injection is a no-op
 * and responsive overrides won't apply — surfaceable in tests.
 */
function injectAttrsIntoFirstTag(html: string, attrs: Record<string, string>): string {
  return html.replace(/^(<[a-zA-Z][\w-]*)((?:\s+[^>\/]*?)?)(\s*\/?>)/, (_m, open, existing, close) => {
    let updated = existing ?? '';
    for (const [k, v] of Object.entries(attrs)) {
      // Skip if attribute already present
      const presentRe = new RegExp(`\\s${k.replace(/[-]/g, '\\$&')}(=|\\s|$)`);
      if (presentRe.test(updated)) continue;
      if (v === '') {
        updated += ` ${k}`;
      } else {
        updated += ` ${k}="${escapeHtml(v)}"`;
      }
    }
    return `${open}${updated}${close}`;
  });
}

/**
 * Emit a per-instance `<style>` block carrying @media rules that override
 * CSS variables for each non-mobile breakpoint that has overrides.
 */
function renderResponsiveStyleBlock(
  bid: string,
  cssVars: Partial<Record<Breakpoint, Record<string, string>>>,
  mappedCss: Partial<Record<Breakpoint, string>>,
): string {
  const parts: string[] = [];
  for (const bp of BREAKPOINTS_ABOVE_MOBILE) {
    const inner: string[] = [];
    const vars = cssVars[bp];
    if (vars) {
      // `!important` is REQUIRED here. The mobile baseline is emitted inline as
      // `style="--field:…"` (so `{{field}}` substitution just works), but an
      // inline custom-property declaration outranks any stylesheet rule in the
      // cascade — so a plain `[data-bid] { --field: … }` @media override is
      // silently shadowed and the value never changes across breakpoints.
      // Marking the override important lets it beat the (non-important) inline
      // baseline. Verified in-browser: without it, responsive cols/gap/etc. and
      // grid stack_at are all no-ops above mobile.
      const decls = Object.entries(vars)
        .map(([name, value]) => `--${name}: ${value} !important;`)
        .join(' ');
      inner.push(`[data-bid="${bid}"] { ${decls} }`);
    }
    const mapped = mappedCss[bp];
    if (mapped) {
      // Doubled attribute → specificity (0,2,0), matching a block's
      // `[data-block][style*="--field:token"]` baseline rule; the per-instance
      // <style> is emitted inline (after the bundle) so source order breaks
      // the tie in the override's favour. This is what lets a token field
      // (icon-top → icon-left) flip behaviour per breakpoint.
      inner.push(`[data-bid="${bid}"][data-bid="${bid}"] { ${mapped} }`);
    }
    if (inner.length) parts.push(`${mediaQuery(bp)} { ${inner.join(' ')} }`);
  }
  if (parts.length === 0) return '';
  return `<style data-bid="${bid}">${parts.join('\n')}</style>`;
}

/**
 * Runtime CSS shared across all sites that render blocks. Defines the
 * universal `[data-hidden-{bp}]` rules so individual block styles don't
 * have to. Concatenate this into the per-site blocks bundle once.
 */
export const BLOCKS_RUNTIME_CSS = `
/* Universal visibility control set by Block.hidden_on */
@media (max-width: 639px)                       { [data-hidden-mobile]  { display: none !important; } }
@media (min-width: 640px) and (max-width: 1023px)  { [data-hidden-tablet]  { display: none !important; } }
@media (min-width: 1024px) and (max-width: 1279px) { [data-hidden-laptop]  { display: none !important; } }
@media (min-width: 1280px) and (max-width: 1535px) { [data-hidden-desktop] { display: none !important; } }
@media (min-width: 1536px)                         { [data-hidden-wide]    { display: none !important; } }

/* Archive pager (repeater paginate) */
.tr-pager { display: flex; gap: 0.35rem; justify-content: center; align-items: center; flex-wrap: wrap; margin: 2rem auto 0; }
.tr-pager a, .tr-pager .tr-pager-current {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 2.25rem; height: 2.25rem; padding: 0 0.6rem; border-radius: 0.5rem;
  text-decoration: none; font-weight: 600; font-size: 0.9rem;
  color: var(--color-text, #111); border: 1px solid rgba(0,0,0,0.12);
}
.tr-pager a:hover { border-color: var(--color-primary, #111); color: var(--color-primary, #111); }
.tr-pager .tr-pager-current { background: var(--color-primary, #111); color: var(--color-primary-fg, #fff); border-color: var(--color-primary, #111); }
.tr-pager .tr-pager-gap { opacity: 0.5; padding: 0 0.2rem; }
`.trim();

/**
 * Walk a block tree and collect the set of BlockType ids actually used.
 * Used by the build pipeline (Phase 3) to tree-shake the CSS/JS bundle.
 */
export function collectUsedBlockTypeIds(blocks: Block[], out: Set<string> = new Set()): Set<string> {
  for (const b of blocks) {
    out.add(b.type);
    if (b.children) collectUsedBlockTypeIds(b.children, out);
    if (b.slots) {
      for (const slot of b.slots) collectUsedBlockTypeIds(slot, out);
    }
  }
  return out;
}

export interface BlockAssetBundle {
  /** Concatenated CSS for every used block type. Stable order — sorted by id. */
  css: string;
  /** Concatenated JS. Same stable order. Empty when no block has `script`. */
  js: string;
  /** The block type ids actually included, in the order they appear in the bundle. */
  used_ids: string[];
}

/**
 * Collect the CSS + JS for every BlockType used in a block tree. Order is
 * stable (sort by id) so the output hashes deterministically — important for
 * cache-busting + asset-manifest workflows that ship later.
 *
 * If `registry` doesn't contain a referenced id, that id is silently skipped
 * — the page renderer already surfaces missing blocks via the
 * `onMissingType` callback, so we don't double-warn here.
 */
export interface CollectAssetsOptions {
  /**
   * Include block JavaScript (per-type `script` and per-instance
   * `script_fields`). Default true. The portal preview sets it false when the
   * viewer's org doesn't own the site — preview renders on the portal's
   * origin, so foreign JS there would run with the viewer's portal session.
   */
  includeScripts?: boolean;
}

export function collectBlockAssets(
  blocks: Block[],
  registry: RenderBlocksOptions['registry'],
  opts?: CollectAssetsOptions,
): BlockAssetBundle {
  const ids = [...collectUsedBlockTypeIds(blocks)].sort();
  const css: string[] = [];
  const js: string[] = [];
  const used: string[] = [];

  // Visibility runtime — emitted once for any non-empty bundle, regardless
  // of which blocks ended up used. Costs ~250 bytes; saves every block
  // type from having to repeat the rules.
  if (ids.length > 0) css.push(`/* blocks-runtime */\n${BLOCKS_RUNTIME_CSS}`);

  for (const id of ids) {
    const bt = getRegistryEntry(registry, id);
    if (!bt) continue;
    used.push(id);
    if (bt.styles) css.push(`/* ${id} */\n${bt.styles}`);
    if (bt.script) js.push(`/* ${id} */\n${bt.script}`);
  }

  for (const block of collectInstanceStyles(blocks)) {
    css.push(`/* instance ${sanitizeCssId(block.id)} */\n${block.style_overrides!.custom_css}`);
  }

  // Per-INSTANCE scripts, for block types that declare code fields
  // (BlockType.script_fields — core/embed is the first). These can't ride
  // in the block markup: everything the renderer emits into the body runs
  // through the customer-HTML sanitizer, which strips <script>. Joining the
  // same bundle as per-type scripts puts them outside the sanitized body,
  // exactly where BlockType.script already lives.
  //
  // `includeScripts: false` drops ALL JS from the bundle — both per-type and
  // per-instance. The portal's preview uses it when the viewer isn't a member
  // of the org that owns the site, because preview HTML renders on the
  // portal's own origin next to the session cookie. See render-preview.ts.
  if (opts?.includeScripts !== false) {
    for (const { block, code } of collectInstanceScripts(blocks, registry)) {
      js.push(instanceScriptIife(sanitizeCssId(block.id), code));
    }
  } else {
    js.length = 0;
  }

  return { css: css.join('\n\n'), js: js.join('\n\n'), used_ids: used };
}

function collectInstanceStyles(blocks: Block[], out: Block[] = []): Block[] {
  for (const block of blocks) {
    if (typeof block.style_overrides?.custom_css === 'string' && block.style_overrides.custom_css.trim()) {
      out.push(block);
    }
    if (block.children) collectInstanceStyles(block.children, out);
    if (block.slots) for (const slot of block.slots) collectInstanceStyles(slot, out);
  }
  return out;
}

/**
 * Walk the tree for blocks whose type declares `script_fields`, yielding each
 * non-empty code value in document order. Deliberately NOT sorted by id like
 * the per-type pass: instance scripts may depend on DOM order, and document
 * order is the only ordering an author can reason about.
 */
function collectInstanceScripts(
  blocks: Block[],
  registry: RenderBlocksOptions['registry'],
  out: Array<{ block: Block; code: string }> = [],
): Array<{ block: Block; code: string }> {
  for (const b of blocks) {
    const bt = getRegistryEntry(registry, b.type);
    for (const field of bt?.script_fields ?? []) {
      const code = b.data?.[field];
      if (typeof code === 'string' && code.trim()) out.push({ block: b, code });
    }
    if (b.children) collectInstanceScripts(b.children, registry, out);
    if (b.slots) for (const slot of b.slots) collectInstanceScripts(slot, registry, out);
  }
  return out;
}

/**
 * Wrap one instance's code so it runs scoped to its own element.
 *
 * The author's contract: `el` is the block's root element, already in the
 * document. No return value, no registration call — unlike BlockType.script
 * (which registers a per-type initializer and runs once per instance), this
 * IS the instance, so there's nothing to key it by.
 *
 * `</script` inside the code would close the wrapping tag early and drop the
 * rest of the bundle into the document as markup, so it's neutralised the
 * same way SEOHead escapes JSON-LD.
 */
function instanceScriptIife(bid: string, code: string): string {
  const safe = code.replace(/<\/script/gi, '<\\/script');
  return `/* instance ${bid} */\n(function(){var el=document.querySelector('[data-bid="${bid}"]');if(!el)return;\n${safe}\n})();`;
}

/**
 * Deterministic non-cryptographic hash for asset filenames. Same input →
 * same output across processes (Node + browser). 8 hex chars is enough for
 * collision-free per-site bundles — sites won't have 65k blocks.
 *
 * Uses the FNV-1a 32-bit variant. Crypto-grade hashing is overkill for a
 * filename hint; the file's integrity is implicit in being served from your
 * own CDN.
 */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Math.imul keeps the multiplication in 32-bit signed; >>>0 forces unsigned.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A collection listing with `paginate` set — what archive route
 *  generation needs from a page's block tree. */
export interface PaginatedListing {
  collection: string;
  per_page: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  filter_field?: string;
  filter_value?: string;
}

/**
 * Find the first paginating collection listing in a block tree (repeater
 * or any alias that expands to one — expand_to defaults are merged under
 * the authored data, mirroring render-time alias expansion). The SSG uses
 * this to decide which /page/N/ routes a page needs; one paginated listing
 * per page is the supported shape (the first found wins, matching what the
 * renderer's pager links assume).
 */
export function findPaginatedListing(
  blocks: Block[],
  registry: RenderBlocksOptions['registry'],
): PaginatedListing | null {
  for (const b of blocks) {
    const bt = getRegistryEntry(registry, b.type);
    let data: Record<string, unknown> | null = null;
    if (b.type === 'core/repeater') data = b.data ?? {};
    else if (bt?.expand_to?.target === 'core/repeater') {
      data = { ...bt.expand_to.defaults, ...(b.data ?? {}) };
    }
    if (data && data.source_type === 'collection' && typeof data.paginate === 'number' && data.paginate > 0 && data.collection) {
      return {
        collection: String(data.collection),
        per_page: Math.floor(data.paginate),
        sort_by: typeof data.sort_by === 'string' ? data.sort_by : undefined,
        sort_order: data.sort_order === 'asc' || data.sort_order === 'desc' ? data.sort_order : undefined,
        filter_field: typeof data.filter_field === 'string' ? data.filter_field : undefined,
        filter_value: typeof data.filter_value === 'string' ? data.filter_value : undefined,
      };
    }
    const nested =
      (b.children && findPaginatedListing(b.children, registry)) ||
      (b.slots ?? []).map((s) => findPaginatedListing(s, registry)).find(Boolean);
    if (nested) return nested;
  }
  return null;
}
