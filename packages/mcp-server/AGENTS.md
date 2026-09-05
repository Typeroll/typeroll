# AGENTS.md — Working on a Typeroll site

You are connected to a Typeroll site through `@typeroll/mcp-server`.
This file is your briefing: what the system is, what conventions matter,
what tools to reach for first.

If anything below conflicts with what you observe in the tools, trust the
tools — the platform may have moved since this was written.

**Start here for site-shaped tasks.** When the user wants to build,
migrate, redesign, or brand a site, call `list_skills` first — the server
advertises its own step-by-step playbook (`tr-new-site`, `tr-migrate-wp`,
`tr-brand`, …). Then `read_skill name=…` loads the full recipe. These are
local reads; no API key or site context required.

**Branch first for anything larger than a small edit.** Before a redesign,
a multi-page change, or trying out a new design direction, run
`create_branch name="…"` and pass the returned id as `version=<id>` on every
subsequent read/write. The work stays off the live `main` version until you
`merge_branch` it — nothing ships until you decide it should. Branches default
`robots_blocked:true` and get their own deploy URL for stakeholder review.
It's the cheapest insurance there is; when in doubt, branch. The
`tr-redesign-branch` skill walks the whole flow. (Small, low-risk single edits
can go straight to main.)

## What this is

Typeroll is a static-site CMS: content lives in a database, the user
edits it through an in-app editor, and a deploy step compiles everything
to a fast static site hosted on Cloudflare Pages. The in-app chat handles
single-page or single-block edits by the editor audience. You — through
this MCP — handle the work that doesn't fit there: site-wide redesigns,
bulk content updates, structural migrations, directory imports.

The MCP server is a thin wrapper around the public REST API. Each tool
maps to one HTTP endpoint; the actual logic runs in the customer's portal
(SaaS or self-hosted).

## The data model in 90 seconds

- **Pages.** Title, slug, status (`draft | review | unlisted | published`),
  body content + SEO fields. Two body shapes selectable per page via
  `content_mode`:
  - `blocks` (DEFAULT for new pages) — `blocks: Block[]` tree of typed
    blocks (heading, prose, section, columns, image, button, plus any
    user/third-party block types installed on the site). Use the
    block-mutation tools (`add_block`, `update_block`, `move_block`,
    `remove_block`) for structural changes.
  - `html` — body lives in `html_content` as a single HTML string.
    Useful when you have hand-written markup to drop in directly.

  Slug is a single path segment — no slashes. `about` → `/about`,
  `kontakt` → `/kontakt`, empty string `""` → homepage. The v1 API
  rejects `services/design` and other slash-containing slugs with
  "Invalid slug … slugs must not contain slashes." For nested URLs
  like `/blog/{slug}` or `/services/{slug}`, the right primitive is a
  **collection with `route_template`** (see the `tr-blog` and
  `tr-directory` skills) — not a flat page with a slashed slug.

- **Partials = global blocks.** Three kinds:
  - `header` — auto-injected at the top of every page.
  - `footer` — auto-injected at the bottom of every page.
  - `free` — reusable HTML you drop into a page with
    `<x-include name="block-id" />`. Free blocks are how you avoid
    duplicating HTML across HTML-mode pages.

  Partials themselves also support `content_mode='blocks'` — pass a
  `blocks: Block[]` tree to `update_partial` and the renderer composes
  it the same way as a page. Useful for header/footer authored with
  block types.

- **Collections.** Repeatable content types (blog, team, events,
  products, restaurants for a directory site, etc.). Each has a schema
  (`fields[]`) and optional **per-item routing** via `route_template`
  (e.g. `/restaurants/{slug}`). When set, every published item gets its
  own static URL rendered through `item_template_html`. Set
  `route_template=""` to opt out and keep the collection listing-only.

- **Settings.** Site name, tagline, logo, favicon, colors, fonts,
  contact info, social links, SEO suffix, default meta description
  (`default_meta_description` — site-wide fallback for pages without a
  `seo_description`; tagline is the last resort), plus `scripts_head`,
  `scripts_body_end`, `custom_css` (writable via the API — your bearer
  token authorises shipping arbitrary CSS/JS to the live site, just
  like editing a partial's HTML does).

- **Analytics attribution.** `read_funnel_attribution` and
  `update_funnel_attribution` manage the Analytics module's validated,
  site-level rules that forward
  allowlisted query parameters to exact HTTPS link targets. Optional
  first-/last-touch storage is consent-gated and off unless configured. Read
  the current config before writing. For advertising pass-through, preserve
  only incoming or stored values and omit `fallback`: a fallback creates
  synthetic attribution when no campaign value exists. The API rejects such
  fallbacks unless `allow_synthetic_fallbacks=true` explicitly acknowledges
  that behavior. A target `click_event` is recorded as a consent-gated,
  first-party conversion when Analytics is enabled; the event contains only
  the declared funnel, destination, page path, and resolved allowlisted
  attribution. Navigation never waits for analytics.

- **Core modules.** `list_apps`, `read_app`, and `update_app` expose the
  code-defined core-module registry (the `apps` API name is retained for
  compatibility) through the same admin API key used for content
  and deploys. Read the schema before writing. Secret fields stay masked on
  reads and encrypted at rest; omitted fields preserve their current values.
  When `affects_build` is true, deploy after the update.

- **Extension installations.** `list_extension_installations`,
  `read_extension_installation`, and `update_extension_installation_config`
  expose each installed Extension's manifest-defined config through the admin
  API key. Read the installation before writing so you use the exact keys from
  `manifest.config_schema`. This is the supported automation path for public
  content such as consent copy, link text, and policy URLs; masked secrets are
  preserved when omitted. The update queues a production deploy by default;
  pass `deploy: false` only when batching several changes and deploy once after
  the final update.

- **Page templates.** A `PageTemplate` is a Block[] tree that wraps a
  page's body. The template contains exactly one block of type
  `template_content_slot` — at render time that block gets replaced by
  the page's own `blocks`. Set `Page.template = "<template-id>"` to
  apply a template to a page.

- **Block types.** A site has three sources of block types:
  - **Core** (origin: 'core', ids like `core/section`) — shipped in
    the platform, always available.
  - **User** (origin: 'user') — created in the portal's block-types UI.
  - **Third-party** (origin: 'third_party') — imported from .tcblocks
    packages via `import_block_types`.

  `list_block_types` returns ALL of them in one list as a lightweight
  summary: each entry's id, label, category, container/slot info, origin,
  and full field schema (names, types, defaults) — but NOT the render-time
  template/styles/script (omitted so the list stays within token budget as
  the library grows). Use `read_block_type` for one block's markup, or pass
  `full:true` to inline it for every block. Always call this FIRST before
  working with blocks — never hardcode block ids or field names, the
  available set is per-site.

  **The core library is larger than you'd guess (~30+ blocks): `core/image`,
  `core/media_card`, `core/gallery`, `core/hero`, `core/feature_grid`,
  `core/icon_box`, `core/cta`, `core/testimonial`, `core/accordion`, …** Before
  you report a block as "missing" or reach for a `core/html` workaround, call
  `list_block_types` and check — a real build once hand-built every illustration
  in `core/html` and filed a false "no image block" gap because the library was
  never enumerated. Prefer a native block; `core/html` is the last resort.

  Block-library specifics worth knowing (template_capabilities_version
  0.15.0):
  - **`core/media_card`** — image + text side by side (image left/right,
    width third/two-fifths/half, heading + richtext + button, optional
    card background/radius; stacks image-on-top below 720px). Use it for
    the classic "photo next to copy" layout instead of hand-building
    section+grid+html.
  - **`core/search`** (0.29.0+) — site search over the deployed site.
    Place the block anywhere; the deploy pipeline detects it, runs
    Pagefind over the built HTML, and the block loads the search UI at
    visit time. Index = page content only (nav/footer excluded); noindex
    pages stay out. Editor preview shows a placeholder note (the index
    only exists on the deployed site).
  - **Archive pagination** (0.29.0+): a collection listing
    (`core/collection_list` / `core/repeater`) with `paginate: N` renders
    N items per page + a pager, and the build generates `/page/2/`… routes
    automatically. `paginate` supersedes `limit`; one paginated listing
    per page.
  - **`core/feature_row`** (0.29.0+) — the full-width "zig-zag"
    feature/step row: balanced halves that hug the center gutter (no
    wide-screen dead air), natural-aspect image (never cover-cropped —
    that's media_card's card look), eyebrow + heading + richtext +
    button pair, `image_side: left|right` per row, `stack_order`
    controls what comes first on mobile. Prefer it over `core/columns`
    with an unbalanced ratio + width-capped text for these rows.
  - **`core/hero` and `core/cta` render their buttons server-side** via
    `primary_label`/`primary_url` + `secondary_label`/`secondary_url`.
    (The old `buttons` array relied on client hydration that never
    existed — if you see `data-buttons` in stored content it renders
    nothing; rebuild with the explicit fields.)
  - **`core/image` gets responsive `<picture>` automatically at build
    time** — the deploy pipeline's SEO transform converts CDN `<img>`
    into `<picture>` with AVIF/WebP srcset variants. You do NOT need
    `core/html` for responsive images; just point `src` at an uploaded
    media URL (run `generate_image_variants` first) and optionally set
    `radius`. Note: the in-portal preview shows the plain `<img>` — the
    `<picture>` upgrade appears on the deployed site.
  - **Icons render inline SVG** (since template_capabilities_version
    0.16.0). Every `type: 'icon'` schema field — on `core/icon`,
    `core/icon_box`, `core/step_card`, and custom block types — renders
    a stroke-based inline SVG when the value is a name from
    `get_site_capabilities → core_icon_names` (a curated Lucide subset:
    `check`, `star`, `shield-check`, `mail`, `arrow-right`, `zap`,
    `truck`, `chart-line`, …). Any other value (emoji, plain text) is
    rendered as escaped text, so emoji stand-ins keep working. Icons
    size with `font-size` (the SVG is 1em) and paint with
    `currentColor`. Custom block templates opt in by placing the derived
    raw token `{{{<field>_svg}}}` where the icon should appear. On
    pre-0.16.0 portals icons don't render — use emoji or CSS markers.
    `core/tabs` label icons are the remaining gap (tab strip is built
    client-side).
  - **Grids with a partial last row: set `last_row: 'center'`** (since
    template_capabilities_version 0.16.5). Five equal cards in a 3-col
    `core/grid` (or 7 in 4, ...) left-align the orphans by default; with
    `last_row: 'center'` the last row auto-centers. THE DESIGN RULE: when
    N peer cards don't divide by the column count, center the last row or
    change the column count — NEVER invent a "wide"/full-width variant of
    one peer card just to fill the hole. Special treatment is a content
    decision, not a layout patch.
  - **`core/section` is natively full-bleed on block pages** (since
    template_capabilities_version 0.14.0): the section's background runs
    edge-to-edge and meets the header with zero gap; content inside is
    constrained by the section's own inner container (`width` field:
    narrow/normal/wide/full). Never use 100vw negative-margin hacks.
    Top-level blocks that are NOT sections still get a classic centered
    container as fallback. Anchor ids and custom classes via
    `style_overrides` are safe on full-bleed sections since 0.15.3 —
    they merge into the `<section>` element itself. On 0.14.x–0.15.2
    they wrapped the section in a `<div>`, which silently disabled
    full-bleed for that section.
  - **Shaped section transitions** (since template_capabilities_version
    0.24.0): `core/section` takes `divider_top` / `divider_bottom`
    (`none | wave | curve | tilt`). The platform paints the divider in the
    section's OWN `background` and overlaps the neighbour by 1px, so a
    cream↔colour transition renders seam-free. **Use this for waves/curves —
    never hand-roll a divider band in `core/html`** (a separate stacked shape
    seams against the next section as a sub-pixel hairline in Chrome). Put the
    divider on the section whose colour should "rise/dip" into the neighbour
    (usually the lower section's `divider_top`).
  - **`core/html`** is the raw-HTML escape hatch for block-mode pages —
    one `html` field rendered verbatim (then sanitized like HTML-mode
    content). Use it for the genuinely unique thing no block covers.
    Prefer real blocks when one fits.
  - **Structured records at scale** (template_capabilities_version ≥ 0.31.0).
    Four things landed together for directory-shaped sites:
    - `collection_completeness` — **start an enrichment pass here**, not by
      paging every item. Returns per-field gap counts plus the N worst
      records (missing fields, never-verified fields, fields whose last write
      is older than the staleness window), computed at read time. Fields no
      API key may write are excluded by default: a gap you can't close is
      noise.
    - **Per-field write authority.** A collection field can declare
      `writable_by` (`portal | owner | agent | app | import`). A write you're
      not permitted, or one that would overwrite a higher-precedence writer
      (a human correction, the listed business's own edit), comes back as
      **409 with the losing field names** — never a silent no-op. Treat that
      as "already handled" and record it; retrying will lose again.
    - **Item references.** `item_ref` / `item_ref_list` fields point at items
      in another collection (`ref_collection`). The reverse direction is
      computed at render time — don't try to maintain backlinks yourself.
      Render them with a `core/repeater` whose `source_type` is `related`
      (a ref field on the current item) or `backlinks` (who points at it).
    - **Taxonomy pages.** `CollectionDef.facets` generates one page per
      distinct field value. ⚠️ This turns record count into ROUTE count, and
      route count is what the build timeout measures. `min_items` (default 2)
      keeps thin-content pages out, and combination pages must be listed
      explicitly in `facet_combinations` — never assume a cartesian product.
  - **`core/embed`** (template_capabilities_version ≥ 0.30.0) is
    `core/html` plus behaviour: an `html` field and a `js` field. Reach
    for it when a one-off placement needs JavaScript. **A `<script>` tag
    written into `core/html` — or into any page/block markup — is stripped
    by the sanitizer no matter which credential wrote it**, so this field
    is the supported route, not a workaround. The code runs in an IIFE
    with `el` bound to the block's root element and ships in the page's
    block bundle, outside the sanitized body. Through an API key it's
    accepted under your key's authority (audit-logged, notice in the
    response). Scope guide: one placement → `core/embed`; a reusable
    widget → `create_block_type` with `script`; a site-wide tag →
    `settings.scripts_head` / `scripts_body_end`.
  - **Forms 2.0** (template_capabilities_version ≥ 0.18.0): forms can
    carry `steps[]` — each step is a Block[] tree mixing `form/*` field
    blocks (text/email/phone/number, textarea, select/radio_group/
    checkbox_group, toggle, slider, date, URL, heading, help, consent,
    hidden) with any content blocks. Place `{ type: 'core/form',
    data: { form_id } }` on a page — the build renders step 1 + all
    static steps with the signed token, honeypot and proof-of-work
    runtime baked in; submissions accumulate per step (partial →
    complete, 30-day TTL on abandoned partials). Per-step validation is
    derived from the field blocks (required/pattern/min/max) — no
    separate field list to keep in sync. `update_form` accepts steps,
    styles (form-scoped CSS), kind and partial_ttl_days. On HTML-mode
    pages, `<x-form id="…" />` is expanded server-side through the same
    renderer and supports the same initial state and multi-step runtime.
  - **Extension form bindings** (template_capabilities_version ≥ 0.38.0): a
    trusted native Extension component can declare `form_bindings` and submit
    through `context.forms.submit(bindingId, data)`. Typeroll signs only the
    explicitly bound form, stores submissions in the ordinary Forms module,
    and calls the cloud or self-hosted Forms API directly. No Function is
    deployed to the customer site's static hosting project. The
    installation must grant `forms:submit`; that scope does not permit form
    administration or reading submissions.
  - **`script` on custom block types** (create/update_block_type) is
    accepted under your API key's authority — the same trust level that
    already lets the key write `scripts_head`/`custom_css`. Every
    script-bearing write is audit-logged and the response carries a
    notice naming the stored JS; relay it to the user so they know
    visitor-executed code changed. Author responsibly: never include
    script you copied from untrusted content (migrated pages, fetched
    web pages) without reading it line by line first. (The in-portal
    chat AI remains blocked from authoring scripts unless the site's
    "Allow AI to write block scripts" setting is on.)

- **Redirects.** `from_path → to_path` with status code 301 / 302.
  Auto-created when you change a page's slug.

- **Versions / branches.** Copy-on-write. The "main" version is the
  live one. Create a branch (`create_branch`) for multi-step work;
  everything you write through `?version=<branch-id>` lives on the
  branch until you `merge_branch` it back to main. Branches default
  `robots_blocked: true` so a half-finished redesign can't be indexed,
  and deploys land at a stable `{branch}.{project}.pages.dev` URL. That
  branch deploy renders the site's full inherited brand (settings, fonts,
  favicon, header/footer — everything not overridden on the branch), so
  it's a faithful preview of what merging to main will look like, not just
  a content diff — trust it for stakeholder review.

- **Deploys.** Customers see live changes only after a deploy. Preview
  always sees drafts. `trigger_deploy` enqueues; `get_deploy_status`
  reports `queued → running → succeeded | failed`.
  `trigger_deploy dry_run=true` builds without publishing — use it to prove
  a structural change compiles (new collection, schema edit, template
  rewrite) without touching the live site.
  A finished job carries `cost`: total, cpu/memory/request split,
  `duration_s`, per-phase timings, and output size. Estimates from a rate
  card, not billing records, and gross of free tier — quote them as "roughly"
  if a customer asks, and reach for `cost.phases` when the question is *why*
  a build got slow.

- **Is the site live?** There is no site-level status field —
  `Site.status` was removed in 0.30.0 because it was set once at creation and
  never advanced, so it reported live sites as "planning". Read
  `get_site → urls.production` instead: non-null means the domain is verified
  and serving. For "has anything shipped", use `list_deploys`.

- **Site URLs.** `get_site` returns a `urls` object with:
    - `production` — the customer's real domain (or null)
    - `fallback` — the auto `{slug}.typeroll.app`-style preview URL
    - `preview_base` — the portal preview origin (for token URLs)
  Use these in answers to "what's the URL?" — never invent.

- **For design/content iteration, share the DB-LIVE preview — don't deploy.**
  `get_preview_link` renders straight from the database with NO build, so a
  reload shows every edit immediately. Mint it ONCE and REUSE that single
  URL: it's stable across edits (internal links keep the token, so one link
  navigates the whole branch) and stays valid for 24h by default, so you
  re-mint only when it lapses — never per edit. This is
  both the link you hand the user while iterating AND what you open to verify
  your own changes. Do NOT `trigger_deploy` merely to preview a content/design
  change — a deploy builds static pages (slow) and only reflects state as of
  that build.
- **THE BUFFER MODEL — every content write is a draft; saving is always
  explicit.** All content writes (update_page, replace_page, block tools,
  update_partial, update_collection_item, batch/bulk tools) land in a
  per-doc *working copy* — the same draft layer the portal editor
  autosaves into. Deploys and plain preview links see SAVED content only;
  your drafts are invisible to them until committed. The loop:
    1. Edit freely — reads (`read_page`, `get_page_blocks`) return the
       draft view (plus `has_unsaved_changes`), so chained edits compose.
    2. Look at it: `get_preview_link` / `get_page_preview` with
       `include_working_copy: true` (the link flag is signed into the
       token, so your iteration link needs one mint with the flag).
    3. SAVE explicitly: `commit_working_copy`, or `save: true` directly on
       the write call (typical for pre-approved changes and batch sweeps).
       Commit = the editor's Save button: revision snapshot, SEO
       transform, redirect hygiene. Rejected → `discard_working_copy`.
  Exceptions that apply immediately (they are publish state / structure,
  not content): `status` fields, create/delete, `set_page_mode`,
  templates, settings, redirects, block-type definitions, media.
  The human editor shows your drafts as "Unsaved changes" it can Save or
  Discard; `read_working_copy` shows the raw unsaved diff when you need to
  know whose edits are in it. Working copies are per-doc scratch; for
  multi-page efforts branch instead (`create_branch`).
  **Before `trigger_deploy`: commit.** Deploys build saved content only —
  an uncommitted draft silently stays behind.
- **Deploys / `{branch}.{project}.pages.dev` are the STATIC BUILD**, refreshed
  only by `trigger_deploy`. Reach for them when you want the real compiled
  output: publishing, a stakeholder link to the built site, or a faithful
  pre-merge check. The branch alias is permanent across re-deploys; the
  per-deploy `{hash}.pages.dev` is immutable per build. Reserve deploys for
  these — not for previewing edits.

## Discovering this site

Don't hardcode assumptions about what's here. Every fact about the site
goes through the MCP:

**Capability discovery is a required gate for every build, migration and
redesign.** Before choosing HTML mode, hand-writing a component, or reporting
that Typeroll lacks a feature, call `get_site_capabilities` and
`list_block_types` (`full:true` only when you need every template). If a likely
type appears, call `read_block_type` and inspect its schema. A capability gap is
valid only after those reads show that neither a core/site block nor a
composition of `core/section`, layout blocks, `core/repeater`, template blocks,
or a custom block type can express the requirement. Record the calls and the
closest available primitive in any gap report. This is a completion criterion,
not optional discovery.

1. `get_site` — confirm the key works; learn the site name + URLs.
2. `read_site_settings` — colors, fonts, contact info, SEO suffix,
   content language (used by `suggest_alt_text_context`).
3. `list_pages` — what pages exist, paginated.
4. `list_partials` — what shared blocks already exist. **Defaults to
   summary mode** (no html_content, just bytes count) — pass
   `include_content: true` if you actually need the bodies inline.
5. `list_collections` — what content types exist + their schemas +
   `route_template` (so you know if items have URLs).
6. `get_site_capabilities` — renderer version and feature flags. Never infer
   support from remembered release notes.
7. `list_block_types` — every block type usable on this site: core
   (always available, ids like `core/section`), custom (origin: 'user'),
   and third-party (origin: 'third_party'). Each entry includes the
   full schema so you know what `data.X` fields each block accepts.
8. `list_page_templates` — PageTemplate docs that wrap pages.

For a build, migration, redesign, or capability report, #1–#8 are the
preflight. For a small content-only edit, #1 + #2 + a sampling from #3 is
usually sufficient.

**Source of truth = the live site (the API), by default.** The content and
structure you read back through the MCP (`read_page`, `read_partial`,
`read_site_settings`, …) is canonical. Local files in the project folder —
`sources/*.md` copy drafts, briefs, old exports — are PROPOSALS, not truth:
treat them as authoritative only when the user explicitly says "use the copy
in `<file>`". When rebuilding or redesigning, derive copy and structure from
the live page, not from a local draft, unless told otherwise. And if you edit
copy directly on the live site, sync it back to the corresponding draft file
in the same pass — otherwise the two diverge and the next agent inherits stale
text. (This is a real failure mode: a copy draft that had drifted from the live
page once sent a whole redesign off the approved wording.)

**Don't have a site yet?** With an org-scoped key you can `create_site
name="Acme"` — it bootstraps settings + a draft Home page + a published
header/footer and returns the new site id. Use that id as `site_id`
(hosted) / `TYPEROLL_SITE_ID` (stdio) for follow-ups, then run
`list_skills` → `read_skill tr-new-site` to design it. A site-scoped key
can't create sites (it's bound to one) and gets a 403.

## Common operations

### "Replace this string across the whole site"

```
search_pages contains="299 kr"             → matches + excerpts
bulk_replace_text dry_run=true ...          → sample_diffs
# show the user, get confirmation
bulk_replace_text dry_run=false ...         → write
trigger_deploy                              → ship
get_deploy_status job_id=…                  → poll until succeeded
```

Writes go through the normal save pipeline (SEO transform + revision
snapshot) so changes are reversible from the in-app History tab.

### "Audit / understand the site"

```
list_pages limit=200                              → inventory
batch_read_pages page_ids=[…]                     → bulk-load bodies
list_partials                                     → shared blocks (summary)
find_pages_using_block partial_id=<id>            → blast radius per block
list_collections                                  → content types + routing
list_collection_items collection=<name>           → items (richtext hidden)
```

`find_pages_using_block` for the header or footer returns the full
page list (they're auto-injected on every page).

### "Redesign the home page"

```
get_site + read_site_settings
read_partial partial_id="header"
list_pages → batch_read_pages a few existing pages    # learn conventions
# Propose redesign locally; ask user to confirm.
create_branch name="Home redesign"                    # ID is, say, "home-redesign"
update_page page_id=home patch={ html_content: "…" } version=home-redesign
get_preview_link page_id=home version=home-redesign  # DB-live URL — mint once, reuse while iterating (no deploy); 24h TTL by default
# Iterate (reload the same link after each edit). When approved:
merge_branch version_id=home-redesign
trigger_deploy
```

The branch also has its own permanent deploy URL at
`https://home-redesign.<project>.pages.dev` after `trigger_deploy
version=home-redesign` — useful for "share with stakeholders without
showing them my preview token". `read_version version_id=home-redesign`
returns it as `deploy_url`.

### "Build a reusable block"

If you see the same HTML on 3+ pages, propose a free block instead of
duplicating it:

```
create_free_block id="newsletter-cta" html_content="<form>…</form>"
# Then on each page where it should appear (HTML-mode pages):
update_page page_id=… patch={ html_content: "<…><x-include name=\"newsletter-cta\" />" }
```

Edits to the block update every page that includes it. Use
`find_pages_using_block` before changing it.

### "Build a page using blocks (the default for new pages)"

New pages default to `content_mode='blocks'` with a seeded heading +
prose block. Discover-then-build:

```
list_block_types
# → [{ id: "core/section", category: "layout", container: true, schema: [{ name: "width", type: "select", options: ["narrow","normal","wide","full"] }, …] },
#    { id: "core/columns", container: "slots", slot_count: 2, slot_labels: ["Left","Right"], schema: [...] },
#    { id: "hero_bold", origin: "user", schema: [...] },   ← any custom blocks on this site
#    …]

get_page_blocks page_id=home
# → { content_mode: 'blocks', blocks: [...] }

add_block page_id=home block={ type: 'core/section', data: { width: 'wide' } }
# → { added_id: 'blk_xyz', blocks: [...] }
add_block page_id=home parent_id="blk_xyz" block={
  type: 'core/heading', data: { text: 'Pricing', level: 'h2' }
}
add_block page_id=home parent_id="blk_xyz" block={
  type: 'core/prose', data: { html: '<p>…</p>' }
}
```

Slot containers (`container: "slots"` — `core/columns`, `core/tabs`)
hold their children in per-slot lists, not in `children`. Two ways to
populate them (both require template_capabilities_version ≥ 0.15.2):

```
# Inline — pass the whole subtree in one call:
add_block page_id=home block={
  type: 'core/columns', data: { ratio: '1-1' },
  slots: [
    [{ type: 'core/prose', data: { html: '<p>Left column</p>' } }],
    [{ type: 'core/image', data: { src: '…' } }],
  ]
}

# Incrementally — slot_index picks the slot (0-based, defaults to 0):
add_block page_id=home block={ type: 'core/columns', data: {} }
# → { added_id: 'blk_cols' } — slots are auto-initialised to the type's arity
add_block page_id=home parent_id="blk_cols" slot_index=1 block={
  type: 'core/prose', data: { html: '<p>Right column</p>' }
}
```

For an unfamiliar custom block, `read_block_type id="..."` gives the
full field list (types, defaults, required) so you don't ship invalid
`data`.

Updating, moving, removing blocks: `update_block`, `move_block`,
`remove_block` (all by `block_id`).

### "Switch a page between blocks and HTML"

Use `set_page_mode` — it snapshots a revision before flipping, so the
previous state is restorable:

```
# Convert an HTML-mode page to blocks with auto-heuristic conversion:
set_page_mode page_id=about to=blocks convert=true

# Or just switch the mode without converting (empty blocks):
set_page_mode page_id=about to=blocks

# Switch back to HTML (drops the block tree; revision retains it):
set_page_mode page_id=about to=html
```

The heuristic converter recognises `<h1-4>` → heading, `<img>` → image,
`<a.btn>` → button, `grid-cols-2` → two-column, `<section>` / hero divs
→ section. Anything it can't classify becomes a `core/prose` block,
which preserves the raw HTML losslessly. Run with `convert_page_to_blocks
dry_run=true` first if you want to inspect the proposal before
committing.

### "Build a directory site / import structured data"

```
create_collection
  name="restaurants"
  label_singular="Restaurant" label_plural="Restaurants"
  fields=[ ...title, slug, address, phone, cuisine, body... ]
  route_template="/restaurants/{slug}"
  item_template_html="<article><h1>{{title}}</h1>… {{{body}}}</article>"

# For each row in your source data:
create_collection_item collection="restaurants" fields={…} status="published"

# Each published item now lives at /restaurants/{slug}, included in
# sitemap.xml. Preview a specific one:
get_preview_link collection_name="restaurants" item_id="<id>"

# Optional listing page:
list_collection_items collection="restaurants" limit=200
update_page page_id=restaurants patch={ html_content: "<hand-written listing>" }
```

### "Migrate a content type (e.g. WP custom post type)"

```
list_collections                                     # what exists today?
read_collection name=blog                            # what fields are writable?
batch_read_collection_items …                        # load items (richtext hidden)
# Transform locally; then:
update_collection_item …  (or)  create_collection_item …
```

Fields outside the schema are silently dropped — call `read_collection`
first if you're unsure what's writable.

### "Add images to a page"

```
# Image lives on a URL somewhere (Unsplash, customer's existing CDN):
upload_media_from_url source_url="https://..." alt_text="Hero photo of …"
  → returns { media_id, cdn_url, finalize: {…}, finalize_error: null }

# OR image lives in your memory (image-gen output):
upload_media_inline filename="hero.png" content_type="image/png"
                    data_base64="iVBORw0KGgo…"
  → returns the same shape

# Both tools auto-finalize after PUT: immutable Cache-Control on the
# original PLUS AVIF/WebP variants at 320/640/1024/1920. No manual
# generate_image_variants call needed. The site-template renderer reads
# the variants array off the Media doc and emits <picture> automatically
# — you can keep the <img src="{cdn_url}"> markup simple.
#
# INTEGRITY — don't lose bytes in transit. upload_media_inline carries the
# file as a base64 string through the model/tool boundary; a payload beyond a
# few KB can be SILENTLY CORRUPTED there (mutated chars → a broken-but-valid
# file that uploads fine and only fails when rendered — it has eaten half a
# logo SVG). For anything non-trivial, and ALWAYS for SVG/logos or generated
# assets, prefer upload_media_from_url (fetch by URL) or create_upload_url +
# `curl --data-binary @file` (bytes go straight to R2, byte-identical). After
# uploading a generated asset, verify it (render/byte-diff) before referencing.
#
# Media is NOT branch-scoped — the library is shared across all versions of
# the site. Uploads are additive and safe (they never overwrite the live logo
# until you reference the new URL in settings/a partial), but a redesign branch
# shares its media with main; there's no per-branch media isolation.

# Then embed in a page:
read_page page_id=...
update_page page_id=... patch={ html_content: "<...><img src='{cdn_url}' alt='…' /></...>" }
```

### "Stop an image over-fetching a too-large variant"

When an image renders much narrower than the viewport (a container-constrained
hero, a sidebar thumbnail), the default `<picture sizes>` of
`(max-width: 768px) 100vw, 800px` makes the browser pull a wider srcset variant
than it needs — Lighthouse flags it as wasted bytes. Three levers, narrowest
wins:

```
# 1. Per-image: put a real `sizes` on the <img>. Survives the transform verbatim.
update_page page_id=... patch={ html_content:
  "<img src='{cdn_url}' alt='…' sizes='(max-width: 640px) 360px, 560px' />" }

# 2. Per-page default (applies to every image on the page that has no own sizes):
update_page page_id=... patch={ image_sizes_default: "(max-width: 640px) 360px, 560px" }

# 3. Site-wide default (fallback under the page default):
update_site_settings image_sizes_default="(max-width: 640px) 360px, 560px"
```

Precedence: per-image `sizes` > page `image_sizes_default` >
site `image_sizes_default` > the generic built-in. To opt a single image out of
the platform's auto-`<picture>` entirely, hand-write your own `<picture>` with
custom `<source media=…>` — the transform leaves an existing `<picture>`
untouched (it no longer re-wraps the inner `<img>`).

### "Fill missing alt-text across the media library"

```
list_media                                 → find items where alt_text is empty
suggest_alt_text_context media_id=<id>     → returns image_url + tuned prompt
                                             + language + nearest-heading context
# Pass image_url + the returned suggested_prompt to YOUR OWN vision
# capability. The platform does NOT run vision for you.
update_media media_id=<id> alt_text="<what vision returned>"
```

The prompt is tuned for SEO-grade output: 5-15 words, written in
`settings.language`, skips "image of" filler, decorative images return
empty string.

### "Change a page's URL safely"

```
update_page page_id=about patch={ slug: "om-oss" }
  → response includes:
     auto_redirects: [{ from_path: "/about", to_path: "/om-oss",
                        status_code: 301 }]
     sanitization_warnings: []
```

The 301 fires automatically — you don't have to remember.

Redirect hygiene is automatic in both directions (since 0.16.1):

- When a **live** (published/unlisted) page takes over a URL — via slug/path
  change, publish, or create — any redirect FROM that URL is retired; the
  response lists them under `retired_redirects`. A real page always beats a
  redirect (on Cloudflare Pages a redirect would otherwise shadow the page).
- When a page is **deleted**, auto-generated redirects pointing TO its URL
  are removed (reported as `removed_redirects`). Manually created redirects
  are kept — delete them yourself via `delete_redirect` if they're obsolete.

### "Before you start an import"

```
get_migration_readiness
```

Call this before moving any content. Every check it runs fails SILENTLY
otherwise — the import succeeds, previews render, the customer signs off, and
something is quietly wrong:

- **media storage** (blocker) — without it every `<img>` keeps its original
  URL, so the new site is still served images by the old host. Nothing looks
  broken until that hosting is cancelled, at which point every image on every
  page breaks at once.
- **hosting adapter** (blocker) — without credentials, deploys return a job id
  and publish nothing, while reporting success.
- verification origin, AI reconstruction, form notification email, and whether
  the target actually has a design to rebuild INTO (warnings).

`ready: false` means STOP and report the blockers, each of which carries a
`fix`. Don't start "and fix it after": the content work would have to be
redone. The in-portal migration workflow enforces the same gate as its first
step (`skip_preflight: true` overrides it, and logs that it did).

### "Don't lose URLs in a migration"

Two different questions, and you need both answers:

```
list_migration_urls status="unhandled"     # what the DATA says is uncovered
verify_migration_urls                      # what the SERVER actually answers
```

`list_migration_urls` classifies every inventory URL against the site's
current pages + redirects. It's recomputed on read, so creating a redirect
flips the entry on your next call — no bookkeeping of your own. Slash-equivalent
source URLs share one inventory row, but `observed_paths` preserves the exact
spellings that were discovered.

`verify_migration_urls` requests each URL against the deployed site (its
fallback subdomain by default, because the real domain still points at the
old host pre-cutover) and reports `ok` / `ok_redirect` / `missing` /
`broken_redirect` / `error`. This is the one that catches a redirect
pointing at an unpublished page, a typo'd `path`, and redirect loops — all
of which read as "handled" in the coverage report and as a 404 to Googlebot.
Every distinct `observed_paths` value is requested, so a slash variant can fail
even when its normalized inventory row is green; `summary.checked` counts those
requests rather than normalized rows.
**Deploy first**: it tests saved, deployed content, not your drafts.

Imports created before plain-text normalization may still contain WordPress
entities or markup in titles and SEO text. Use
`repair_migration_plain_text` for those records. It accepts only `title`,
`seo_title`, `seo_description`, and `excerpt`; it cannot touch rich content,
slugs, paths, or URLs. The tool defaults to a dry run with exact field diffs.
Show the full diff/conflict result to the user and obtain approval before
calling it with `dry_run=false`. Existing working copies are conflicts and are
never overwritten or committed by the repair.

Every unhandled URL gets exactly one of three outcomes — there is no fourth:

- it moved → `create_redirect`
- it's gone on purpose → `update_migration_url url_id=… excluded=true` (with
  a note saying who signed off)
- it should exist → migrate it

Populate the inventory yourself when the in-portal WordPress migration
didn't: `add_migration_urls` takes up to 2000 entries from a sitemap walk, a
GSC export (pass `gsc_clicks` so the report prioritises itself), or a crawl.
Pass `source_origin` whenever more than one old domain is in play — it
rejects foreign-origin URLs, which is what stops one market's `/kontakt`
from reading as another market's coverage.

For a whole family of sites, read the `tr-migrate-multisite` skill.

### "Retire a family of old URLs in one rule"

```
create_redirect from_path="/category/*" to_path="/blogg/:splat"
create_redirect from_path="/blog/:slug" to_path="/artiklar/:slug"
```

A trailing `*` captures everything under a prefix (including the prefix
itself) and `:splat` replays it; `:name` matches exactly one segment and is
replayed by name. This is the right tool after a WordPress migration, where
the dead URLs come in shapes — `/category/`, `/tag/`, `/author/`, `/2019/` —
and the inventory only knows the subset it happened to find.

Constraints, all enforced at write time rather than discovered in production:

- **Trailing `*` only.** Cloudflare silently drops a mid-path splat, so the
  rule would save fine and do nothing.
- **`:splat` requires a `*`**, and `:name` in the target must be declared in
  `from_path`.
- **Query strings can't be matched** — `_redirects` keys on the path. A
  WordPress `/?p=123` URL has to be handled at the source.
- **A rule that would hide a live page is refused**, naming the pages.
  Redirects are applied BEFORE static files, so `/blogg/*` makes every real
  article under `/blogg/` unreachable. Narrow the prefix.

Rules are emitted most-specific-first, so `/blogg/recept/*` and `/blogg/*`
can coexist — the narrower one fires. `list_migration_urls` counts
pattern-covered URLs as `redirected`, so the coverage report reflects what
production will do. A build emits both slash spellings for redirect sources
(except root and file/resource paths) and normalizes internal destinations to
the site's trailing-slash policy. Changing this behavior requires a new build,
not a migration of stored redirect records.

### "Link language versions together (hreflang)"

One Typeroll site owns one domain, so `example.se` / `example.de` /
`example.co.uk` are three sites. Nothing can derive which page corresponds
to which — declare it per page:

```
update_page page_id=om-oss patch={ alternates: [
  { hreflang: "de",        href: "https://example.de/ueber-uns" },
  { hreflang: "x-default", href: "https://example.com/about-us" }
]}
```

The renderer injects this page's own self-reference, so list only the OTHER
variants. Clusters must be **reciprocal** — write all sides, `batch_update_pages`
is the sane way. Use absolute URLs on the FINAL domains (never the
`*.typeroll` fallback). Invalid tags/hrefs are rejected at write time with
the reason rather than silently dropped at render.

### "Change the site's fallback URL (slug)"

```
update_site slug="acme"
  → response includes:
     urls.fallback: "https://acme.sites.typeroll.com"
     dns_note: "New fallback URL … attached to CF Pages. SSL provisioning
                takes 1–10 minutes after DNS propagates. …"
```

The slug change triggers DNS + CF Pages reprovisioning behind the scenes.
**Always check the response for `dns_note` vs `dns_warning`:**

- `dns_note` present → the new fallback URL was wired up; warn the user it
  may take 1–10 min for SSL to provision before the URL serves.
- `dns_warning` present → the slug was saved but DNS / CF attach failed.
  The `urls.fallback` field is still returned (it's just `{slug}.{base}`
  string formatting) but the URL will NOT resolve until the issue is
  fixed. Surface the warning verbatim to the user — don't tell them the
  URL is ready.
- Neither present → self-hosted portal without CF/SITES_BASE_DOMAIN
  configured; URL behaviour is up to the operator.

The old fallback URL keeps working (bookmarks + SEO survive). Customer
can manually deprovision the old one via the portal.

## Safety boundaries

- **HTML is sanitized at save.** No `<script>`, no `onclick`, no
  `javascript:` URLs in page or partial bodies. `<style>` blocks DO
  survive — multi-page sites need authored CSS for `@media` queries,
  `:hover`, theming, etc. Inside `<style>` we strip a small list of
  legacy code-execution constructs (`expression()`, `behavior:url`,
  `@import`, `url(javascript:)`) but leave normal CSS alone.
- **Write responses include `sanitization_warnings: []` (strings) and
  `sanitization_details: []`** (structured records `{ kind, label,
  count, bytes? }`). Use the structured form to programmatically retry
  with a fixed input.
- **scripts_head, scripts_body_end, custom_css** are now writable via
  `update_site_settings` and readable via `read_site_settings`. Same
  trust model as user-authored block-type JS: an API caller with a valid
  bearer token takes responsibility for what they ship. The chat AI
  inside the portal continues to NOT expose these fields, so a
  conversation-driven assistant can't smuggle scripts in.
- **The API key is site-scoped.** Cross-site reach is impossible — a
  key on the wrong site returns 401, indistinguishable from "bad token".
- **Audit log.** Every state-changing call (POST / PATCH / PUT /
  DELETE) is logged. Reads aren't. The customer sees "Acme agency key
  wrote to /pages/home at 14:32" in the portal.
- **Rate limits.** 600 reads/min, 60 writes/min per key. On 429 the
  response carries `Retry-After`.

## Preview-driven workflow

After any non-trivial change, verify against the DB-live `get_preview_link`
(reused — mint once; 24h TTL by default) and/or your own browser tool before moving
on. It reflects the DB instantly with no build, so it — not a deploy — is the
loop for design/content iteration. One reload vs. shipping a broken redesign —
always worth it.

**To UNDERSTAND a page, render it to one HTML file — don't reconstruct it
from the block tree in your head.** A page is assembled at render time from the
block tree + each block type's template/styles + the header/footer partials +
the settings CSS variables + the global shell + page-scoped styles. `get_page_blocks`
gives you the editable *structure*; `get_page_preview` gives you the rendered
*result* — the WHOLE page as one self-contained HTML document (header + body +
footer, with all of that CSS inlined), exactly as deployed. Read that when you
need to see what the page actually looks like or why its CSS cascades the way it
does (write it to a local file + serve+screenshot it to review visually). Pass
`annotate:true` to tag every element with `data-block-id` + `data-block-type`,
so you can map a spot in the rendered HTML straight back to the block to edit:
read preview to understand → find the element → its `data-block-id` is the block
to mutate → edit → re-render to verify.

**CSS precedence — where your overrides land in the cascade.** The render order
is: core block-type `styles` (emitted first) → settings `custom_css` → the
header/footer partial `<style>` blocks → the page's own page-scoped `<style>`
(emitted last). Same specificity → later wins, so **page-scoped CSS beats
partial CSS beats core block CSS**. Consequences when you brand/override:
- Site-wide design tokens + utilities → settings `custom_css` (or, on a branch,
  `update_site_settings version=<branch>`). Header/footer-only tweaks → the
  partial. One page → that page's `<style>`.
- Core blocks set their own chrome (e.g. `core/image` gives `figure>img` a
  `border-radius`/`margin`; `.page-content img` adds more). To override that
  chrome from a header-partial utility class you often need `!important`,
  because a partial rule and the core rule can tie on specificity and the core
  bundle's source position is unpredictable relative to yours. That `!important`
  is expected today — it is NOT a smell. (A future cascade-`@layer` model would
  remove the need; until then, reach for `!important` on the override and move
  on rather than escalating selector specificity.)
- An edge-overlapping decoration (a badge/garland that pokes past an image's
  corner) needs its wrapper at `overflow:visible` and the motif in a
  `::before`/`::after` — never rely on the image's own clipped box.

**A design review is a multi-DIMENSION, MEASURED pass — not "copy present + no
overflow + images 200".** If you have a browser tool, walk every dimension (the
`tr-redesign-branch` skill has the full checklist with how-to):
- **Responsive** — width ladder (≈390/768/1024/1440/1920px) + a sweep just below/
  above the page's own @media breakpoints; `scrollWidth <= clientWidth` at every
  width (bugs hide between the two extremes); + 200% zoom.
- **Visual & brand** — logo FULLY visible (screenshot the header IN CONTEXT, never
  the logo element in isolation — that hides clipping) + brand-compliant; no
  divider seams / clipped glows / cropped faces / fade-cutoffs; typography +
  palette + spacing consistent.
- **Accessibility (measure)** — actual contrast ratios (AA 4.5:1 / 3:1), alt on
  every image, one `<h1>` + no skipped levels, visible focus, labels on inputs,
  ≥44px touch targets, landmarks, reduced-motion.
- **Functional** — form actually works (action + token + honeypot, long values
  don't break), every link/`#anchor` resolves, ZERO console errors.
- **Content** — no unrendered `{{…}}`, no placeholder, copy matches the live page.
- **Findable** — title + meta description + og:* + canonical + favicon + lang +
  noindex-on-branch.
- **Fast** — images sized right + modern format + width/height set + lazy/eager.
- **Cross-browser** — re-check another engine if possible, or flag risky props
  (backdrop-filter, -webkit- masks, 100vh→100svh, sticky-in-overflow).
"Looks good in Chrome at 1440" ≠ "works for everyone, everywhere" — never report a
design as perfect/approved off a glance or a partial pass.

Preview shows DB state (drafts included). Live (`get_site → urls.production`)
shows the most recent deploy. Branch deploys live at
`get_version → deploy_url` (`{branch}.{project}.pages.dev`).

## Branches

For multi-step work, create a branch:

```
create_branch name="Pricing refresh"
```

The response includes `id` — pass that as `version=<id>` on every
subsequent call. The branch is independent of main; writes don't affect
the live site until you `merge_branch`.

Branches default `robots_blocked: true`. While iterating, preview the branch
with a reused `get_preview_link` (DB-live, no build). Deploys to a branch land
at a stable URL (`{branch}.{project}.pages.dev`) — that's the compiled static
build, for sharing the finished result / stakeholder review, not per-edit
preview.

## When in doubt

- **Read before you write.** A `read_page` round-trip is cheap and
  stops you overwriting unrelated changes.
- **Dry-run bulk operations.** `bulk_replace_text` accepts `dry_run:
  true` and returns 3 sample diffs. Show them to the user before the
  real run.
- **Watch the sanitization_warnings array.** If it's non-empty, the
  stored HTML differs from what you sent. Read it back to confirm.
- **One small confirmation > one large undo.** The audit log makes it
  obvious who did what, but a clean revert across many pages is still
  more work than asking "ok to proceed?" first.
- **Match the site's design.** Read a partial or two before designing
  new components. CSS variables (`var(--color-primary)`) are common
  but not universal — mirror what's already in use.

## Reference: tool families

| Family       | Tools |
|---|---|
| **Guide + skills (playbook)** | `read_guide` (returns this whole guide — the bridge for hosted clients that can't read it off disk), `list_skills`, `read_skill` — the bundled `tr-*.md` recipes (incl. `tr-responsive` for per-breakpoint layout). Call `list_skills` first when a task looks like "build / migrate / redesign a site", then `read_skill name=…`. No API key or site context needed. |
| **Discovery** | `get_site`, `create_site` (org-scoped key only — see below), `update_site`, `list_versions`, `read_site_settings` |
| **Insights** | `get_site_insights` — traffic, AI-assistant referrals, and first-party conversion events over 7/30/90 days. Read-only. Traffic is powered by Cloudflare Web Analytics; conversion rows come from validated Analytics attribution `click_event` targets and can be present even when the traffic provider is unavailable. |
| **Pages — reads** | `list_pages`, `read_page`, `batch_read_pages` |
| **Pages — writes** | `create_page`, `update_page`, `replace_page`, `batch_update_pages`, `delete_page`, `clone_page` |
| **Pages — blocks** | `get_page_blocks`, `add_block`, `update_block`, `move_block`, `remove_block`, `set_page_mode`, `convert_page_to_blocks` |
| **Pages — meta** | `get_page_preview` |
| **Global blocks (partials)** | `list_partials` (summary by default), `read_partial`, `create_free_block`, `update_partial`, `replace_partial`, `delete_partial`, `find_pages_using_block`, `list_blocks_with_usage` |
| **Block types** | `list_block_types`, `read_block_type`, `find_pages_using_block_type`, `export_block_types`, `import_block_types` |
| **Collections** | `create_collection`, `update_collection_schema`, `delete_collection`, `list_collections`, `read_collection`, `list_collection_items` (richtext hidden by default), `read_collection_item`, `batch_read_collection_items`, `create_collection_item`, `update_collection_item`, `delete_collection_item`, `regenerate_collection_listing` |
| **Media** | `list_media`, `read_media`, `create_upload_url`, `upload_media_from_url`, `upload_media_inline`, `update_media`, `delete_media`, `finalize_media`, `finalize_all_media`, `generate_image_variants`, `suggest_alt_text_context` |
| **Redirects** | `list_redirects`, `create_redirect`, `delete_redirect`. `from_path` may be a PATTERN: a trailing `*` (with `:splat` in the target) or `:name` for one segment — one rule retires a whole family of dead URLs (`/category/*` → `/blogg/:splat`). Mid-path splats and query strings are refused, as is any rule that would hide a live page. |
| **Migration inventory** | `get_migration_readiness` (preflight — CALL FIRST), `list_migration_urls`, `add_migration_urls`, `update_migration_url`, `update_migration_urls`, `delete_migration_url`, `import_sitemap`, `import_gsc_performance`, `repair_migration_plain_text`, `verify_migration_urls`. Sitemap indexes are recursive. GSC supports direct Search Console access or CSV and aggregates fragment variants. Plain-text repair is allowlisted and dry-run-first. Verification is compact by default. |
| **Forms** | `list_forms`, `read_form`, `create_form`, `update_form`, `delete_form`, `list_form_submissions`, `delete_form_submission` (removes one submission — e.g. cleaning up a test entry; `delete_form` with `delete_submissions` is the bulk path). **Steps (form/* block trees) are the ONLY stored model**: pass `steps` for funnels, or `fields` for simple forms — the server converts a flat field list to a single static step. Place with a `core/form` block on block-mode pages or `<x-form id="…" />` in HTML mode. Both expand server-side to the same complete signed shell and initial state. Email/webhook actions are admin-only in the portal and excluded from agent reads/writes. |
| **Settings** | `update_site_settings` (whitelist) |
| **Core modules** | `list_apps`, `read_app`, `update_app` (legacy API name; admin; schema-driven config, masked secrets, redeploy when `affects_build` is true) |
| **Extension installations** | `list_extension_installations`, `read_extension_installation`, `update_extension_installation_config` (admin; schema-driven config, masked secrets preserved, production deploy queued by default) |
| **Analytics attribution** | `read_funnel_attribution`, `update_funnel_attribution` (specialized Analytics module tools; admin; redeploy after changes) |
| **Search + bulk** | `search_pages`, `check_internal_links`, `bulk_replace_text`. The link check is database-driven. Bulk replace defaults to pages but can target partials, collection items or all resources, always dry-run first. |
| **Branches** | `create_branch`, `read_version`, `delete_branch`, `merge_branch` |
| **Deploy** | `trigger_deploy`, `list_deploys`, `get_deploy_status` |
| **Preview** | `get_preview_link`, `get_page_preview` |

Every tool's input is validated server-side; the MCP server only does
auth + shape. If a tool returns `isError: true`, the body carries
`{ error, status, body }` from the underlying HTTP response.
