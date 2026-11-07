# Fonts, menus, site fields, live snippets and templates

Status: proposal (2026-11-07). Five areas where a site builder, an agency or an
app needs more than Core offers today. Each section says what exists, what is
missing, the proposal, and whether it belongs in Core or in an app.

The rule used for that choice: **what other features or apps build on belongs in
Core** (data models, storage, rendering, scopes and APIs). **Workflows, catalogs
and vertical tools belong in apps** (a restaurant's lunch editor, an agency's
paid section packs).

Everything new that changes published output for existing sites ships behind a
new render version (15), so versions 1–14 render exactly as before.

## 1. Fonts

**Today.** `SiteSettings.fonts` holds a heading, body and mono family as free
text (Google Fonts names only). The portal suggests only `system` and `Inter`.
Publication self-hosts by default: it fetches Google's CSS, copies the woff2
files into the frozen publication and serves them from `/_typeroll/fonts/`, with
a metric-matched fallback against layout shift. Weights are fixed at 400, 500,
600 and 700. There are no italics, so a block that offers 800 gets a faked bold.
Nothing can be uploaded (`font/*` is refused). There is no Adobe Fonts support
and no preview anywhere. The editor preview loads from Google's CDN even when
the site self-hosts.

**Proposal (Core).**

- **Font catalog.** A curated list of open-licence families (SIL OFL or Apache;
  starting with roughly 150 from Google Fonts and Fontsource). Each entry has
  its category, weights, italics, variable axes, scripts, licence and fallback
  metrics. The portal and MCP search it with filters such as category, variable
  and Swedish characters. A family outside the list still works by name, as
  today.
- **Only the weights in use.** The publication works out which weights and
  styles the site actually uses: style roles, block `font_weight` fields,
  `<strong>` and `<em>` in rich text, and the default heading weight. It loads
  only those. A variable font loads as one file covering the needed range, not
  one file per weight. Italics load only when the site has italic text. The main
  body file (Latin subset) gets a `preload`. With render version 15 this
  replaces the fixed 400–700.
- **More font roles.** Besides heading, body and mono, an optional `display`
  (large headings and heroes) and `accent` (eyebrows and quotes). Style roles
  and blocks keep choosing a role, never a family name, so a template still
  follows the site it is inserted into.
- **Your own fonts.** A per-site **Fonts** library (not the media library). It
  takes woff2, woff, ttf and otf, with family, weight, style and a licence
  confirmation. ttf and otf are converted to woff2 on upload and the original is
  kept; one variable file can cover several weights. The `@font-face` rules,
  fallback metrics and self-hosting work as for catalog fonts. Uploaded families
  appear in the font picker next to the catalog.
- **Adobe Fonts and other services.** A web project ID (kit) for Adobe Fonts.
  Its stylesheet loads from Adobe's CDN, because Adobe's licence does not allow
  self-hosting. The kit's families can then be picked for a role. The settings
  show a privacy note, as for Google's CDN. The same field takes a Bunny Fonts
  or Fontshare stylesheet.
- **Preview everywhere.**
  - The font picker shows each family with sample text in the site's language,
    in its weights, beside the site's own heading and body.
  - The same picker serves the site settings, the style editor (each role
    shows its sample) and a block's font setting.
  - The editor preview loads the site's own self-hosted files, so it matches
    the published site.
- **MCP:** `search_fonts`, `set_site_fonts` (role → family and weights) and
  `upload_font`. The lint `css_font_not_in_theme` already steers agents away
  from loading fonts in their own CSS.

## 2. Menus

**Today.** There is no menu entity. Menus are `navigation_links` blocks inside
the header and footer partials. Links are typed URLs, so renaming a page leaves
the menu pointing at a redirect. There are no submenus, no menu locations and no
menu editor. New pages are never added. The WordPress client can read WP menus,
but nothing imports them.

**Proposal (Core).**

- **Menus as site documents** (`menus/{id}`, per site and version, like
  partials). Each menu has a name and a tree of items. An item is one of:
  - a page (by id)
  - an address
  - a page's children (an automatic submenu)
  - a heading without a link (a column title in a large menu)

  An item can override its label and add a description and an icon. The tree
  is up to three levels deep.
- **Locations.** `primary`, `footer` and `mobile`, plus named locations a site
  adds. A `navigation_links` block gets the source `menu` (a menu id or a
  location) as an alternative to inline links. Existing blocks keep their
  links.
- **Pages follow.** Page items take their label and address at build time, so
  renames and moves follow. A deleted page drops out with a warning in the
  publication's report. A menu can choose to "add new top-level pages
  automatically", as in WordPress.
- **Submenus** (render version 15):
  - On desktop: a dropdown on hover or focus, with a button that opens it from
    the keyboard and works on touch.
  - In the mobile drawer: an accordion.
  - A first-level item can open a **panel** instead: a global block (free
    partial) shown as a large dropdown. That is a mega menu built from ordinary
    blocks.
  - Following the WAI disclosure-navigation pattern, with `aria-expanded`,
    Escape to close and `aria-current` on the active page and its parent.
- **Menu editor** in the portal: a tree with drag and drop, a search for pages
  to add, custom links and a preview. A starter header and footer use the
  `primary` and `footer` menus.
- **MCP:** `list_menus`, `read_menu`, `update_menu` (the whole tree, revision
  checked) and `add_menu_item`.
- **WordPress migration** imports WP menus and their locations into menus,
  linked to the imported pages.

## 3. Site fields (settings pages)

**Today.** Site settings are a fixed, checked set of keys. Content types already
have a complete typed field model: text, textarea, boolean, number, select,
dates, image, link, page reference, and lists and groups with nested fields.
`{{site.*}}` in templates resolves the whole settings document. A workaround
exists: a content type without addresses and one page holding the values. The
editor then sees a page, not a settings page.

**Proposal (Core).**

- **Site field definitions:** one or more **settings pages**, each a titled
  group of `FieldDefinition` fields, the same model as content types. A builder
  or an agency defines them. Values are stored in `SiteSettings.fields`.
  Examples:
  - a checkbox "Show the booking calendar"
  - a textarea "Visiting address"
  - a number "Delivery days right now"
  - a dropdown with options
  - an **opening hours** field type: seven days, each with open and close
    times or closed, plus exceptions by date
- **Editors edit values, not definitions.** A content editor (the client) may
  change the values on a settings page but not the definitions or the design
  settings. Only an administrator changes the fields themselves.
- **Use in pages:**
  - `{{site.fields.x}}` and `{{#each site.fields.x}}` work in templates and
    block text, since `siteContext()` already passes on settings.
  - A small `core/site_field` block shows one value inline with a format (date,
    number, list, opening hours: today's, the week's or the next opening).
  - A conditional container shows or hides blocks by a field ("show the
    booking calendar").
- **Live fields.** A field marked *live* is also written as a live snippet when
  saved (section 4). Its block then shows the newest value without a
  publication, for example the current delivery time. Other fields take effect
  at the next publication; a partial build only republishes pages that use the
  changed field.
- **Apps and extensions.** New scopes `site_fields:read` and `site_fields:write`.
  Fields marked public reach extension components as `context.site.fields`.
  An app can define its own settings page in its manifest (for example a
  restaurant app's "Lunch hours"), stored and edited like the site's own.
- **MCP:** `define_site_fields`, `read_site_fields` and `update_site_fields`.

## 4. Live snippets (content outside the build)

**Today.** A published site is always a complete static artifact (no Functions,
no changing files in place). Content that changes without a publication exists
only through extension components that fetch from their app's own Worker, as
Recurring Events does. There is no general, static way to show today's lunch on
the start page without rebuilding it every day.

**Proposal (Core): live snippets as small static JSON files outside the
publication.**

- **What a snippet is:** a named piece of content per site, either HTML (run
  through the publication's sanitizer when saved) or a value (text, number,
  a list).
- **Content by date.** A snippet can hold entries keyed by date or weekday. The
  page shows today's entry in the site's time zone, chosen in the visitor's
  browser. A week's lunches are written once a week, never daily, and the file
  is unchanged between writes.
- **Where the files live:** in the site's own media bucket under
  `live/{snippet}.json`, written immediately on save, with a short cache (about
  60 s) and `stale-while-revalidate`. This is the customer's R2 bucket for
  customer-owned publishing, Typeroll's storage for hosted mode. No database or
  Function is involved. The bucket gets a CORS rule for GET from the site's own
  addresses.
- **On the page:** a `core/snippet` block renders the value as it was at the
  latest publication, so the content is there without script, for search
  engines and in print. A small runtime then fetches the newest file and
  replaces it. A live site field (section 3) is a snippet of one value.
- **Updated by:**
  - editors, in a simple snippet editor (text, or a table by date)
  - agents through MCP (`list_snippets`, `update_snippet`)
  - apps through the scope `snippets:write`

  A restaurant app can therefore offer a structured form for the week's lunches
  per day and write the snippet itself. Nothing is published or rebuilt.
- **Limits:** 64 KB per snippet and 100 snippets per site. The editor and the
  page show when it was last updated. A snippet never changes the page's
  structure; it fills a place reserved in advance.

## 5. Templates, collections and site copies

**Today.** Block templates exist, but only per site, and they are not in the
content export. The built-in starters (pages, sections, header and footer) are
fixed in code, with bracketed placeholder text and no pictures. Global blocks
and site block types (with props) are per site. Only block types can move
between sites (`.tcblocks`). There is no organization collection, no copy and
paste between pages or sites, no import of the export and no "new site from a
template". Templates follow the design of the site they are inserted into when
they use colour tokens and the standard styles, but nothing checks or converts
that.

**Proposal. In Core, because apps and agencies build on it:**

- **One package format** (`.typeroll`, JSON plus media). It carries block
  templates, sections, page templates, global blocks, block types, styles and
  tokens, menus, site field definitions, and whole sites.
  - Export and import in the portal and through MCP.
  - The existing content export becomes a full site package that can be
    imported.
- **Organization collection.** Templates, sections, page templates and block
  types stored at organization level.
  - Visible to organization members (owner, administrator, and a new
    *designer* role).
  - Inserted into any of the organization's sites, and saved there from any of
    them.
  - A client given access to one site does not see it.
- **Copy and paste of blocks** between pages and sites through the clipboard
  (JSON with a marker). Pasting checks block types and moves media into the
  target site's library. Ctrl/Cmd+C and V in the block editor, and
  `copy_blocks` / `paste_blocks` in MCP.
- **New site from a template:** a site package, or another site of the
  organization, as the starting point for a new site. Pages, partials, menus,
  styles, site fields and media are copied; domains, publishing and keys are
  not.
- **Templates that follow the site:**
  - Saving a template flags hard-coded colours and font families and offers the
    nearest token or role.
  - On insert, a style id the target site lacks is mapped to the nearest
    standard style.
  - Text can use variables such as `{{site.name}}` and site fields.
  - Sample text is in the site's language when the template carries several
    languages.
  - Demo images are marked as demo content and listed for replacement before
    publication.
- **The built-in starters become collection entries:** pages, sections and the
  Advanced Design patterns. They gain demo images and sample text instead of
  brackets.

**In an app (Agency app, paid):**

- Typeroll's ready-made collections: section packs per industry, and complete
  demo sites to start a client site from.
- Client handover: lock design and structure, a checklist and an
  editor-friendly start view.
- An agency's own collection shared across its client organizations, and
  white-label.
- Snippet editors and settings-page presets per industry: restaurant, shop,
  clinic.

## Order

1. **Menus.** High everyday value, a contained change, and the starter header
   and footer improve at once.
2. **Site fields** with conditions and `core/site_field`. Agencies need it for
   client sites, and apps build on it.
3. **Live snippets**, including live site fields. They need the bucket's CORS
   rule and the runtime, and then unlock the restaurant case.
4. **Fonts:** the catalog, weights in use, preview and uploads (Adobe last).
5. **Templates and collections:** the package format first, then copy and paste
   and the organization collection, then site copies. The Agency app last, on
   top of them.

## Decisions (2026-11-07)

- **Adobe Fonts:** supported through Adobe's CDN (a web project ID). It is the
  only way Adobe's licence allows, with the privacy note in the settings.
- **Snippets:** stored in the customer's media bucket (`live/`), with a CORS rule
  for the site's own addresses.
- **Roles:** a new organization-level **builder** role (`builder`). It works on
  structure, design, templates and the collection across the organization's
  sites, without member, billing or publishing-connection rights.
- **Agency app:** a selection of Typeroll's ready-made collections is part of
  the paid Agency app, together with client handover.
- **Order:** as proposed. Menus first.
