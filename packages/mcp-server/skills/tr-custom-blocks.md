---
name: tr-custom-blocks
description: Use when a Typeroll site needs a block the core library does not have (an icon list, cards, steps, a team strip), so the user wants a reusable block type with its own fields.
---

# Build a site block type

A site block type is reusable: editors place it and fill in its fields, and
every instance updates when the type changes. Build one when the same section
shape recurs, or when editors should fill in fields rather than arrange
blocks. For a one-off section use plain blocks; for a section copied and then
adapted per page use a block template; for content that must be identical
everywhere use a global block.

Creating, changing and deleting block types needs admin permission. A changed
block type reaches the live site with the next deploy.

## 1. Look before you build

```
list_block_types                 # core and site types: maybe it exists
list_block_type_starters         # icon_list, feature_cards, steps
list_styles                      # the site's named styles to use inside
```

Prefer a starter or a core block with the right settings over a new type.

## 2. Compose it from existing blocks

Composed is the default. Declare the editable fields in `schema` and build the
markup from core blocks in `composition`:

- An inner block field set to exactly `"{{props.name}}"` takes the block's
  field value. Bindings keep their type (lists, links, booleans).
- For a repeating group, add a `core/repeater` with
  `items: "{{props.items}}"`, `source_type: "static"` and no `item_block`. Its
  children render once per item and read the item with `"{{item.title}}"`.
- Make a whole item a link with a `core/container`
  `{ tag: "a", href: "{{item.link.href}}", new_tab: "{{item.link.new_tab}}" }`.
  Items without a link render as a plain container.
- Use `core/text` for values from text fields (always escaped), `core/heading`
  for headings, `core/icon`, `core/image`, `core/button`.
- Give inner blocks named styles (`style_id`) instead of CSS where you can.

Field types: `text`, `textarea`, `richtext`, `image`, `icon` (`{name}_svg`),
`link` (`{ page_id }` or `{ url }` plus `new_tab`; resolves to `href`, `target`,
`rel` and follows page renames), `select` with `options`, `boolean`, `number`,
`array` (`fields`, `item_label`, `min_items`, `max_items`), `object`.

## 3. Check and preview before saving

```
validate_block_type definition={…}        # problems with paths, e.g. /schema/0/fields/1/name
preview_block_type definition={…}         # html + css with sample data, as published
```

Fix every error. Read warnings: a binding inside other text
(`"Call {{props.phone}}"`) is shown as typed; only whole-value bindings resolve.

## 4. CSS

`styles` apply only inside the block: selectors are prefixed automatically,
`:scope` is the block element, and `html`, `body` and `:root` are refused. Use
`var(--color-primary)` and the site's spacing, not fixed colours, and keep text
at WCAG AA contrast.

## 5. Create, place, deploy

```
create_block_type name="icon_list" label="Icon list" category="content" schema=[…] composition=[…] styles="…"
add_block page_id=<id> block={ type: "icon_list", data: { items: [ … ] } }
get_preview_link page_id=<id>
```

Show the preview to the user. Deploy only when they approve.

## Template block types (advanced)

When the markup cannot be built from blocks, use `template` instead of
`composition`: `{{field}}` (escaped), `{{{richtext_field}}}`, `{{#field}}…{{/field}}`,
`{{^field}}…{{/field}}` (empty), `{{#each items}}…{{/each}}` with `{{@index}}`,
`{{@number}}`, `{{@first}}`, `{{@last}}`, and `{{#link field class="x"}}…{{/link}}`.
A type has a composition or a template, never both.

## Changing a type in use

- Rename a field with `renames: { "old": "new" }` (`"items.old": "new"` inside a
  group): Typeroll moves the data everywhere the type is used.
- Removing or retyping a field that holds data is refused with the list of
  usages unless you send `confirm_data_loss: true`. Ask the user first.
- `find_pages_using_block_type` before deleting; a type in use cannot be
  deleted.

## Pitfalls

- Pasting HTML into a `core/html` block inside a composition: editors cannot
  edit it and it skips the site's styles. Compose from real blocks.
- Binding a text field into `core/prose`: the value becomes HTML. Use `core/text`.
- Nesting links: an icon or button with its own link inside a linked container.
- Linked containers on a site below render version 4: every icon sits in a
  link of its own, so the icon list starter nests links, and an item without
  an address is still a link. The write warns; upgrade the site's rendering
  (`tr-upgrade-rendering`) first.
- Writing `script` without the user's explicit request.
