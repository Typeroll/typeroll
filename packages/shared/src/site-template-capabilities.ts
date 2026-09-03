import { CORE_ICON_NAMES } from './icons.js';
import { EXTENSION_HOST_PROTOCOL_VERSION, EXTENSION_RUNTIME_VERSION } from './extensions.js';

// Capability manifest the renderer (site-template) and API agree on.
//
// Lives in @typeroll/shared so both packages import the same source
// of truth. Agents read this via GET /api/v1/sites/{id}/capabilities to
// decide whether a schema change (e.g. setting route_template on a
// collection) is supported by the template before persisting.
//
// Bump the version when the contract changes. The matrix is hand-
// curated — adding a feature here implies you've actually shipped the
// renderer code that handles it.

export interface SiteTemplateCapabilities {
  /**
   * Semver of this capability contract. Bump on:
   *  - new capability flag (additive)
   *  - removed / renamed flag (breaking)
   *  - bugfix that materially changes how a flag behaves at runtime
   *    (so an agent that cached the previous version knows to re-read)
   *
   * Tracks the @typeroll/mcp-server published version in
   * lockstep when changes ship through that package. Agents key
   * feature detection on this string.
   */
  template_capabilities_version: string;

  // Page bodies
  supports_blocks_mode: boolean;
  supports_html_mode: boolean;
  supports_x_include: boolean;
  supports_inline_style_tag: boolean;
  supports_microdata_attributes: boolean;

  // Collections
  supports_collection_item_routes: boolean;
  supports_collection_listings: boolean;
  supports_grouped_collection_listings: boolean;
  supports_collection_item_navigation: boolean;
  /**
   * Tri-state semantics for CollectionDef.route_template:
   *   null / undefined → backfilled to `/{name}/{slug_field}` at
   *                      render time (this flag = true)
   *   ""               → EXPLICIT opt-out from per-item URLs. Never
   *                      backfilled. effective_route_template = "".
   *   string value     → used verbatim.
   *
   * Agents that want "always route items" should explicitly set
   * route_template — relying on the backfill works today but leaves
   * the doc in an ambiguous state that's harder to grep for.
   */
  collection_route_default_backfill: boolean;
  /** Explicit signal that `""` opts a collection out of per-item URLs
   *  (i.e. backfill does NOT apply to empty string). Surfaced as a
   *  separate flag so the contract is unambiguous in JSON, where
   *  TypeScript doc-comments aren't visible. */
  collection_route_empty_string_is_opt_out: boolean;

  // Page-level features
  supports_page_templates: boolean;
  supports_content_mode_switching: boolean;
  /**
   * Page.path field for nested URLs (e.g. "/erbjudanden/sommar-2026").
   * When true, agents can set `path` on create/update to opt into a
   * nested URL without abusing slug. False on older portals — they
   * still accept the field but ignore it; the renderer falls back to
   * "/" + slug. See docs/page-path-plan.md (C6).
   */
  supports_nested_page_paths: boolean;
  supports_page_seo_suffix_opt_out: boolean;

  // Block-type library
  supports_core_blocks: boolean;
  supports_custom_block_types: boolean;
  supports_third_party_block_packages: boolean;
  /** When true, custom block types may include a `script` field that
   *  executes verbatim in the visitor's browser. Trust model: API
   *  callers + portal-form authors can ship JS; the in-portal chat AI
   *  cannot. */
  supports_custom_block_scripts: boolean;
  /**
   * When true, `core/section` accepts `divider_top` / `divider_bottom`
   * (`none | wave | curve | tilt`). The divider is painted in the section's
   * own `background` and overlaps the neighbour by 1px, so cream↔colour
   * transitions render seam-free without hand-rolled SVG bands. Older
   * portals ignore the fields and render a flat section edge.
   */
  supports_section_dividers: boolean;
  /**
   * When true, the page-preview render accepts `annotate=true` and tags every
   * block root with `data-block-id` + `data-block-type`, so an agent can map
   * the rendered HTML (get_page_preview) back to the block tree (get_page_blocks)
   * it edits. Off by default — production output is never annotated.
   */
  supports_block_annotation: boolean;
  supports_table_of_contents_block: boolean;
  supports_structured_field_editor: boolean;

  // Site settings
  supports_writable_scripts_head_body: boolean;
  supports_writable_custom_css: boolean;
  supports_structured_postal_address: boolean;
  supports_language_per_page: boolean;
  /**
   * When true, the responsive-image transform honors a configurable `sizes`
   * default: `Page.image_sizes_default` overrides `SiteSettings.image_sizes_default`,
   * and a per-`<img>` `sizes` attribute wins over both. Older portals ignore
   * the fields and always emit the generic "(max-width: 768px) 100vw, 800px".
   * Pre-existing author-written `<picture>` wrappers are also left untouched
   * (no nested-picture re-wrap) from this version on.
   */
  supports_responsive_image_sizes_default: boolean;
  supports_site_trailing_slash_policy: boolean;
  supports_icon_192: boolean;
  supports_iframe_host_allowlist: boolean;
  supports_media_batch_upload: boolean;

  // Build pipeline
  supports_dry_run_deploys: boolean;
  supports_block_asset_bundling: boolean;
  supports_per_branch_preview_url: boolean;

  // Core block types known to ship in the platform. Agents that want a
  // version-stable list of "blocks they can always use" check here.
  core_block_type_ids: readonly string[];

  /**
   * When true, schema fields of `type: 'icon'` render to inline SVG for
   * names in `core_icon_names`; any other value (emoji, plain text)
   * renders as escaped text, so pre-pipeline emoji stand-ins keep
   * working. Core templates with icon wells: core/icon, core/icon_box,
   * core/step_card (core/tabs labels render client-side without icons).
   */
  supports_core_icon_rendering: boolean;
  /** Valid icon names for `type: 'icon'` fields (curated Lucide subset). */
  core_icon_names: readonly string[];

  /**
   * The buffer model (0.27.0+): every content write on every surface lands
   * in an unsaved per-doc draft (working copy); saving is always explicit
   * (commit_working_copy or save:true on the write). Deploys and plain
   * previews render saved content only. Agents can key behaviour off this
   * flag when talking to older self-hosted portals where writes applied
   * directly.
   */
  draft_layer_writes: boolean;

  /**
   * 0.29.0+: steps are the ONLY stored form model. A flat `fields` input
   * on create_form/update_form is authoring sugar the server converts to a
   * single static step, so `core/form` renders every form. On older
   * portals, fields-forms don't render through core/form — use the raw
   * embed there.
   */
  forms_steps_only: boolean;

  /**
   * 0.34.0+: HTML-mode `<x-form id="…" />` references are expanded at
   * preview/build time through the same renderer as `core/form`.
   */
  forms_html_directive: boolean;

  /**
   * 0.32.0+: `Page.alternates` renders as `<link rel="alternate" hreflang>`
   * in <head>, with the page's own self-reference injected automatically.
   * The field for cross-domain language clusters — one Typeroll site per
   * domain, so the mapping between sister pages can't be derived and is
   * declared per page. Older portals accept and store the field but emit
   * nothing.
   */
  supports_hreflang_alternates: boolean;

  /**
   * 0.32.0+: the WordPress/legacy URL inventory is reachable over the
   * bearer-authed API (`/api/v1/sites/{id}/migration-urls`) and MCP, not
   * just the in-portal migration dashboard. Includes the parity check that
   * fetches every inventory URL against the new site before DNS cutover.
   */
  supports_migration_url_api: boolean;

  /**
   * 0.32.0+: redirect rules accept wildcard patterns — a trailing `*` with
   * `:splat` in the target, and `:name` placeholders matching one segment.
   * The platform validates them at write time, orders the emitted
   * `_redirects` most-specific-first, and counts a pattern-covered URL as
   * covered in the migration coverage report. Older portals store the
   * pattern verbatim: Cloudflare would honour a trailing splat, but nothing
   * validates it and coverage still reports the URLs as unhandled.
   */
  supports_redirect_wildcards: boolean;

  /** 0.33.0+: validated site-level query forwarding and consent-gated attribution storage. */
  supports_funnel_attribution: boolean;

  /**
   * 0.35.0+: installed Extension components can render as ordinary block
   * instances. The runtime captures only URL inputs declared by the manifest
   * and keeps per-mount in-memory navigation state without changing page paths.
   */
  supports_extension_blocks: boolean;
  /** 0.35.0+: HTML-mode pages mount Extensions. */
  supports_extension_html_directive: boolean;
  /** 0.40.1+: HTML header/footer partials mount Extensions in static builds, including when Astro renders 404 first. */
  supports_extension_html_partial_directive: boolean;
  /** 0.38.2+: browser components call provider APIs directly in deploys and isolated previews, optionally with a signed installation token. */
  supports_direct_extension_api: boolean;
  /** 0.41.0+: Extension context resolves and navigates root-relative site paths inside deploys and navigable previews. */
  supports_extension_site_navigation: boolean;
  /** 0.41.0+: Extension context provides installation-scoped session/local JSON storage, with tab-scoped preview persistence. */
  supports_extension_storage: boolean;
  /** 0.38.2+: admin API keys and MCP can read and update schema-defined Extension installation config. */
  supports_extension_installation_config_api: boolean;
  /** 0.36.0+: Extension components can submit to explicitly bound Typeroll forms. */
  supports_extension_form_bindings: boolean;
  /** Extension host protocol understood by this renderer. */
  extension_protocol_version: typeof EXTENSION_HOST_PROTOCOL_VERSION;
  /** Semver of the browser Extension runtime. */
  extension_runtime_version: string;
  /** Render modes accepted by this renderer. */
  extension_render_modes: readonly ['bundled_component', 'embedded_app'];
}

export const SITE_TEMPLATE_CAPABILITIES: SiteTemplateCapabilities = {
  template_capabilities_version: '0.41.1',

  draft_layer_writes: true,
  forms_steps_only: true,
  forms_html_directive: true,
  supports_hreflang_alternates: true,
  supports_migration_url_api: true,
  supports_redirect_wildcards: true,
  supports_funnel_attribution: true,
  supports_extension_blocks: true,
  supports_extension_html_directive: true,
  supports_extension_html_partial_directive: true,
  supports_direct_extension_api: true,
  supports_extension_site_navigation: true,
  supports_extension_storage: true,
  supports_extension_installation_config_api: true,
  supports_extension_form_bindings: true,
  extension_protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
  extension_runtime_version: EXTENSION_RUNTIME_VERSION,
  extension_render_modes: ['bundled_component', 'embedded_app'],

  supports_blocks_mode: true,
  supports_html_mode: true,
  supports_x_include: true,
  supports_inline_style_tag: true,
  supports_microdata_attributes: true,

  supports_collection_item_routes: true,
  supports_collection_listings: true,
  supports_grouped_collection_listings: true,
  supports_collection_item_navigation: true,
  collection_route_default_backfill: true,
  collection_route_empty_string_is_opt_out: true,

  supports_page_templates: true,
  supports_content_mode_switching: true,
  supports_nested_page_paths: true,
  supports_page_seo_suffix_opt_out: true,

  supports_core_blocks: true,
  supports_custom_block_types: true,
  supports_third_party_block_packages: true,
  supports_custom_block_scripts: true,
  supports_section_dividers: true,
  supports_block_annotation: true,
  supports_table_of_contents_block: true,
  supports_structured_field_editor: true,

  supports_writable_scripts_head_body: true,
  supports_writable_custom_css: true,
  supports_structured_postal_address: true,
  supports_language_per_page: true,
  supports_responsive_image_sizes_default: true,
  supports_site_trailing_slash_policy: true,
  supports_icon_192: true,
  supports_iframe_host_allowlist: true,
  supports_media_batch_upload: true,

  supports_dry_run_deploys: true,
  supports_block_asset_bundling: true,
  supports_per_branch_preview_url: true,

  core_block_type_ids: [
    'core/section',
    'core/columns',
    'core/prose',
    'core/heading',
    'core/image',
    'core/button',
    'core/html',
    'core/media_card',
    'core/table_of_contents',
    'template/item_navigation',
  ],

  supports_core_icon_rendering: true,
  core_icon_names: CORE_ICON_NAMES,
};
