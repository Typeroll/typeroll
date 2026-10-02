# Site block types: fields, markup, CSS and repeating groups

Status: in progress (2026-10-02). Composed block types come first; template
block types use the same fields, validator, preview and packaging.

## Goal

When the core blocks are not enough, a person in the portal, or an agent
through the API or MCP, can create a block type for one site:

- editable fields, including repeating field groups;
- its own markup and CSS;
- a live preview that matches the published site;
- placement on pages like any other block.

Example: an icon list. Each item has an icon, a heading and a line of text,
and the whole item is a link.

## What exists today

Site block types already exist, and the proposal builds on them:

- **Storage:** per site and branch (`paths.blockTypes`), read through the
  version chain. Preview and static build merge them over the core registry.
- **API and MCP:** create, read, update, delete, usage, export and import
  (`/api/v1/sites/{site}/block-types`, `create_block_type` …). The portal has a
  Blocks page with a basic editor.
- **Templates:**
  - `{{field}}` (escaped) and `{{{field}}}` (raw);
  - `{{#field}}…{{/field}}` (shown when set);
  - `{{a.b}}`, `{{=tag}}`, `{{children}}` and `{{slot:name}}`.
- **Fields:** `array` and `object` with sub-fields, `icon`, `image`, `url`,
  `select`, `style` and more. The page editor shows an `array` with sub-fields
  as stacked groups with add and remove.
- **Output:** the whole page body passes through the HTML sanitizer, so a
  template can emit `<a>`, `<svg>` and `<img srcset>` but never script.

## Gaps

1. **No loop.** A template cannot repeat markup for an array. Core blocks with
   lists build their HTML in TypeScript. Three core blocks render no items at
   all because their templates print an array into an attribute: `accordion`,
   `pricing_plan` features and `team_member` socials.
2. **No link field.** `url` stores a copied path, so a slug change breaks the
   link. Block data never resolves `page_ref`.
3. **Derived values stop at the top level.** `icon` gives `{name}_svg` only
   for top-level fields, never inside an array item.
4. **No write-time validation.** Field definitions, template tokens, sections
   and CSS are unchecked. Three write paths (portal, v1/MCP, chat) each keep
   their own field list and checks, and they disagree. For example, the portal
   drops `item_compatible` and rejects repeater containers that its own form
   offers.
5. **CSS is global.** Scoping to `[data-block="…"]` is only advice.
   `checkCustomCss` is never applied to block type CSS.
6. **The builder UI is thin.** It cannot edit options, defaults, sub-fields or
   field order. Markup and CSS are plain text areas. The preview is unsanitized
   and has no site CSS. The page editor has no icon, media or link picker, and
   array items cannot be reordered or duplicated.
7. **Preview and publish differ.** The publication projection drops
   `css_unit`, `render_versions` and some field settings.
8. **No schema evolution.** Renaming or removing a field silently orphans
   data on every page using it. The usage scan misses repeater `item_block`
   references.
9. **Packaging is lossy.** Export drops `item_compatible` and `expand_to`.
   Import rejects repeater containers and overwrites same-named types.

## Two kinds of site block type

1. **Composed (the default).** The block type is a tree of existing blocks
   (heading, text, image, icon, button, list, container, grid, repeater …) plus
   its own fields, called props. Inner blocks take values from the props with
   bindings such as `{{props.title}}`, and a repeater inside the tree loops over
   an array prop, rendering its own children once per item with
   `{{item.title}}`. People who place the block see only the props; the
   structure is fixed. No HTML or CSS is needed, and everything the inner
   blocks do (named styles, responsive settings, image handling, safe links,
   accessibility, render versions) carries over. A small optional stylesheet,
   scoped to the block, covers layout tweaks.
2. **Template (advanced).** The block type has its own markup and CSS, as
   today, with the template language below. Use it when the existing blocks
   cannot express the markup.

The icon list as a composed block type:

```json
{
  "name": "icon_list",
  "label": "Icon list",
  "category": "content",
  "schema": [
    { "name": "items", "type": "array", "label": "Items", "item_label": "title",
      "fields": [
        { "name": "icon", "type": "icon", "label": "Icon" },
        { "name": "title", "type": "text", "label": "Heading" },
        { "name": "text", "type": "text", "label": "Text" },
        { "name": "link", "type": "link", "label": "Link" }
      ] }
  ],
  "composition": [
    { "id": "list", "type": "core/repeater",
      "data": { "source_type": "static", "items": "{{props.items}}", "layout": "list" },
      "children": [
        { "id": "card", "type": "core/container",
          "data": { "tag": "a", "href": "{{item.link.href}}", "new_tab": "{{item.link.new_tab}}" },
          "children": [
            { "id": "icon", "type": "core/icon", "data": { "icon": "{{item.icon}}" } },
            { "id": "title", "type": "core/heading", "data": { "text": "{{item.title}}", "level": "h3" } },
            { "id": "text", "type": "core/prose", "data": { "html": "{{item.text}}" } }
          ] }
      ] }
  ]
}
```

A container set to link renders as a plain container when the item has no
link, so linked and unlinked items mix.

## Design

### 1. One definition, one validator

`packages/shared/src/block-type-definition.ts` validates and normalizes a
block type body. The portal route, v1 API, MCP and the chat use it, so all
surfaces accept the same fields with the same errors.

It returns `{ value, errors[], warnings[] }`. Each problem carries a JSON
pointer (`/schema/0/fields/2/name`) and, for templates and CSS, a line and
column. It checks:

- id and name rules, category and container;
- field names (unique per level, `[a-z][a-z0-9_]*`, no derived suffixes such
  as `_svg`);
- field types, options and defaults;
- nesting depth (3 levels);
- `min_items` and `max_items`;
- the template (section 3) against the schema;
- the CSS (section 4).

Unknown properties are errors, not silently dropped.

### 2. Fields

Existing types stay. These are added or completed:

- **`link`** stores `{ page_id?, url?, label?, new_tab? }`. Use `page_id` for a
  page on the site (it survives slug changes) or `url` for an external
  address. At render it resolves to `{name}.href`, `{name}.target` and
  `{name}.rel`. Only http, https, mailto and tel are allowed; anything else
  gives an empty href.
- **`array` groups** gain:
  - `item_label`: the sub-field shown as the collapsed item title;
  - `min_items` and `max_items`;
  - `default_items`: the items a new block starts with.

  Groups may nest (an array inside an item) to 3 levels.
- **`image`** resolves through the media pipeline to `{name}.src`,
  `{name}.srcset`, `{name}.alt`, `{name}.width` and `{name}.height`. The alt
  text is a sub-value, so the editor can require it.
- **Derived values everywhere.** `icon` → `{name}_svg`, `link` → `{name}.href`,
  `image` → `{name}.src` and the `style` class are computed for top-level
  fields and for every array item, at every depth.

Each field may set `help` (shown in the editor) and `editor_group`
(Content, Appearance, Advanced).

### 3. Template language

The language stays logic-less: sections and values, no expressions. New
sections:

| Syntax | Meaning |
| --- | --- |
| `{{#each items}}…{{/each}}` | Repeat for each array item. Inside, names resolve against the item first, then the block. `{{@index}}` (0-based), `{{@number}}` (1-based), `{{@first}}` and `{{@last}}` are available. |
| `{{^field}}…{{/field}}` | Shown when the value is empty: missing, empty string, empty array or `false`. Pairs with `{{#field}}` as an else. |
| `{{#link field}}…{{/link}}` | Wraps the body in `<a href rel target>` when the link resolves; otherwise renders the body without a link. Takes an optional `class="…"`. |

Rules, checked when the block type is written:

- **Balanced sections:** every section is closed, and in the right order.
- **Known names only:** every name is a schema field, a derived value, an
  `@` loop value or a namespace (`page.`, `site.`, `item.`).
- **Section types:** `#each` needs an `array` field and `#link` a `link`
  field.
- **Raw output:** `{{{…}}}` only for richtext fields and derived HTML (`_svg`,
  `_html`). Everything else is escaped. This closes the current gap where any
  field could be emitted raw.
- **Output is still sanitized** as today. A block type never ships script
  through its template; `script` keeps its own consent rules.

The icon list from the goal:

```json
{
  "name": "icon_list",
  "label": "Icon list",
  "category": "content",
  "schema": [
    { "name": "items", "type": "array", "label": "Items", "item_label": "title",
      "min_items": 1, "max_items": 24,
      "fields": [
        { "name": "icon",  "type": "icon", "label": "Icon", "required": true },
        { "name": "title", "type": "text", "label": "Heading", "required": true },
        { "name": "text",  "type": "text", "label": "Text" },
        { "name": "link",  "type": "link", "label": "Link" }
      ] },
    { "name": "columns", "type": "select", "label": "Columns",
      "options": ["1", "2", "3"], "default": "2", "editor_group": "appearance" }
  ],
  "template": "<ul class=\"icon-list\" data-columns=\"{{columns}}\">{{#each items}}<li class=\"icon-list__item\">{{#link link class=\"icon-list__link\"}}<span class=\"icon-list__icon\">{{{icon_svg}}}</span><span class=\"icon-list__title\">{{title}}</span>{{#text}}<span class=\"icon-list__text\">{{text}}</span>{{/text}}{{/link}}</li>{{/each}}</ul>",
  "styles": ".icon-list { display: grid; gap: var(--space-4, 1.5rem); list-style: none; padding: 0; }\n[data-columns=\"2\"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n.icon-list__link { display: grid; grid-template-columns: auto 1fr; gap: .25rem 1rem; color: inherit; text-decoration: none; }\n.icon-list__icon { grid-row: span 2; font-size: 1.75rem; color: var(--color-primary); }\n.icon-list__text { grid-column: 2; color: var(--color-text-light); }"
}
```

The same tokens work in `render_versions` output, and the engine is shared by
core blocks. Core `accordion`, `pricing_plan` and `team_member` move to
`{{#each}}`. Because that changes published markup, it ships as **render
version 4**, and sites upgrade with the usual preview.

### 4. CSS

Block type CSS is checked with `checkCustomCss`: syntax, script-capable
values and `@import` are refused. Then it is scoped when written, so it can
never style anything outside the block:

- Each selector is prefixed with `[data-block="{name}"]`. `:scope` addresses
  the block element itself, and `:root`, `html` and `body` are refused.
- `@media` and `@container` are kept. `@keyframes` names are prefixed with the
  block name.
- The result goes into `@layer blocks.site`. Site and page custom CSS, which
  sit in a later layer, can still override a site block, and a block cannot
  override platform styles by accident.

The author edits and reads back the CSS as written, without the prefix. The
API returns both `styles` and `styles_compiled`, so agents see what ships.
Warnings cover:

- colours that fail contrast against the site palette;
- fixed pixel font sizes;
- selectors that match nothing in the template.

Blocks use the site's design values (`var(--color-*)`, the type scale and
spacing) and named styles: a `style` field lets the editor choose one of the
site's styles for, say, the item heading.

### 5. Preview that matches publishing

There is one preview renderer for the builder, the page editor and the API.
It uses:

- the site's render version, theme CSS, named styles and custom CSS;
- the sanitizer;
- the other site block types.

`POST /api/v1/sites/{site}/block-types/preview` takes a definition, which need
not be saved yet, and sample data. It returns the HTML, the compiled CSS and
the validation report. MCP exposes it as `preview_block_type`.

The publication projection keeps every render-relevant property. A test fails
when the renderer reads a property the projection drops.

### 6. Editing blocks on a page

The inspector renders array groups as a list of collapsible items titled by
`item_label`. Items support:

- add, duplicate and remove (removal can be undone);
- reorder by drag and by keyboard (move up and down buttons);
- `min_items` and `max_items` limits.

New pickers:

- **icon:** a searchable grid of the core icons;
- **image:** the media library, with required alt text;
- **link:** a page search on the site, an external URL field and a new-tab
  option.

The same widgets serve core blocks with arrays.

### 7. Building a block type in the portal

The Blocks page becomes a builder with these tabs:

1. **Fields:** a visual schema builder. Add, reorder and nest fields; set
   label, help, required, default, options and editor group; build groups with
   their own fields.
2. **Markup:** a code editor with line numbers, autocomplete for field names
   and sections, and live errors from the shared validator.
3. **CSS:** the existing managed CSS editor, with the block scope shown and
   class hints taken from the markup.
4. **Preview:** the shared preview at mobile, tablet and desktop widths, with
   editable sample data generated from the schema.
5. **Usage:** the pages, templates, header/footer and global blocks that use
   it.
6. **JSON:** the full definition, exactly as the API takes it, for copy and
   paste or review.

Starting points:

- a blank block;
- a built-in starter (icon list, card grid, FAQ, steps, logo row, quote);
- a copy of another site block type.

The starters are plain definitions, so agents get them through
`list_block_type_starters`.

Saving runs the validator. Errors block the save; warnings do not. The
builder flags accessibility problems that are known from the definition:

- a link with no text;
- an image field without alt;
- a heading element inside an item with no level choice.

### 8. Changing a block type in use

Block types get a `version` that increases on every schema change. Each update
reports its impact before it is applied:

- **Added fields** take their default in existing blocks.
- **Renames** are explicit: `renames: { "old_name": "new_name" }`, including
  inside groups. Typeroll moves the data in every block that uses the type, in
  saved pages and drafts, after snapshotting a revision of each changed page.
- **Removing or retyping a field that holds data** needs
  `confirm_data_loss: true`. The response lists the affected pages first.

The usage scan also follows repeater `item_block` and `expand_to` references.
A change to a block type reaches the live site with the next deploy, like any
other saved change; there is no separate publish step. Block types live on a
branch like other content, so a larger redesign can still be made on a branch
and merged.

### 9. API, MCP and chat

| Action | API | MCP |
| --- | --- | --- |
| List, read | `GET /block-types`, `GET /block-types/{id}` | `list_block_types`, `read_block_type` |
| Create, update, delete | `POST`, `PATCH`, `DELETE` (shared validator; renames and impact as in section 8) | `create_block_type`, `update_block_type`, `delete_block_type` |
| Validate and preview without saving | `POST /block-types/validate`, `POST /block-types/preview` | `validate_block_type`, `preview_block_type` |
| Starters | `GET /block-types/starters` | `list_block_type_starters` |
| Usage | `GET /block-types/{id}/usage` | `find_pages_using_block_type` |
| Export, import | `.tcblocks` file with every property; import asks to skip, rename or replace on conflict. Files move between any sites, in any Organization or Typeroll instance; there is no shared library. | `export_block_types`, `import_block_types` |

Creating, changing, deleting and importing block types needs **admin**
permission on the site, in the portal, the API and MCP alike. Editors (write
permission) place block types on pages and edit their fields: text, images,
links and list items. `script` keeps its current consent rules.

The chat assistant may build block types without script, through the same
validator and the version chain. Today it reads the raw store, so it misses
types inherited from main.

The MCP guide gains a `tr-custom-blocks` skill covering:

- when to build a block type instead of using core blocks or a block template;
- the template language;
- CSS scoping;
- the icon list as a worked example.

## Phases

Each phase ships on its own and leaves existing sites unchanged.

1. **Composed block types and the engine.**
   - `composition`, props and bindings (`props.`, typed values), a repeater
     that loops over an array prop with its children as the item template, and
     container links that fall back to a plain container.
   - The `link` field and derived values in array items.
   - `{{#each}}`, `{{^…}}` and `{{#link}}` for template block types; core
     `accordion`, `pricing_plan` and `team_member` move to `{{#each}}` under
     render version 4.
   - The shared definition validator on every write path, admin-only
     authoring, block-scoped CSS for new and updated types, and a publication
     projection that keeps every render property.
2. **API and MCP.** Validate and preview endpoints and tools, starters,
   renames with impact reports, usage that follows compositions and
   `item_block`, and lossless export and import.
3. **Page editor.** Collapsible, reorderable and duplicable array items;
   icon, media and link pickers.
4. **Builder.** Composed mode (build with blocks, choose which fields become
   props, or turn a section on a page into a block type), template mode
   (markup and CSS editors), preview, usage, JSON view and starters.
5. **Docs** and the `tr-custom-blocks` skill.

## Decisions

- Only site admins create, change, delete and import block types; editors use
  them on pages and edit their content.
- A changed block type goes live with the next deploy. The impact report and
  rename handling in section 8 still apply.
- Sharing is manual export and import of `.tcblocks` files, between any sites.

## Open questions

- Organization roles apply to every site the Organization owns. A person who
  should be admin on only one site needs a per-site role, which Typeroll does
  not have yet (see "Roles today" below).

## Roles today

- Organization members have one role for all of the Organization's sites:
  owner and admin give admin permission on every site, editor gives write
  permission.
- Organizations created before role enforcement (`roles_enforced` unset) still
  give every member admin permission. They must turn enforcement on before the
  editor role means anything.
- Per-site permission exists for a site shared with another Organization
  (read, write or admin) and for site-scoped API keys (always admin).
