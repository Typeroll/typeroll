---
title: Organization Collection
description: Keep sections, templates, global blocks and block types once for an Organization and insert them into any of its sites, with their styles created on the site, never mapped.
---

The organization collection holds the building blocks an Organization reuses
across its sites: sections, block templates, page templates, free global
blocks, site block types and whole site packages. Save something from one site
and insert it into any other site of the same Organization. The tools wrap
`/api/v1/sites/{siteId}/collection`; the site in the path names the
Organization whose collection it is, and the site an insert goes into.

In the portal, open **Collection** in a site's menu, or the **Collection**
section of the block library in the page editor.

## Who sees it

The collection belongs to the Organization. Its **owners**, **administrators**
and **builders** use it on every site of the Organization; see
[Teams and roles](../../guides/teams-and-roles/#roles). Editors do not see it.

A client given access to one site through a share never sees the collection,
whatever the share's permission: the routes answer `404`, as for a collection
that is not there. A site-scoped API key is bound to one site and does not
reach it either. Use an organization API key or a personal connection.

Organizations that do not enforce roles yet treat every member as an
administrator, so every member sees the collection.

## Built-in entries

Typeroll's starters are listed after the Organization's own entries, marked
`read_only`: page layouts (feature, comparison, integration, pricing and use
case pages) as sections, page templates (article, blog post, landing page and
more), a header and a footer with menus, and block type starters. They follow
the site's render version. They can be inserted, but not changed or removed.
Inserting the built-in header or footer replaces the site's own.

## Entries

| `kind`           | Holds                                                      | Insert into             |
| ---------------- | ---------------------------------------------------------- | ----------------------- |
| `section`        | A block template of kind section                           | The library, or a page  |
| `block_template` | Any other block template                                   | The library, or a page  |
| `page_template`  | A page template                                            | The library             |
| `global_block`   | A free global block                                        | The library, or a page  |
| `block_type`     | A site block type                                          | The library             |
| `package`        | A whole site package (pages, menus, settings pages, media) | The site, as one import |

Each entry carries what it needs: its blocks, the styles and block types they
use, the global blocks they place and their images. The images are stored once
in the Organization's private storage and shared between entries; removing an
entry also removes the files no other entry uses. An entry belongs to the
Organization, not to the site it was saved from: deleting or changing that
site does not change the entry.

`list_collection_entries` answers
`{ entries: [{ id, kind, name, description, category, preview_url, languages, source, read_only, updated_at, summary }] }`.
`summary` counts the blocks (`block_count`, `top_level_types`) and the styles,
block types and media the entry brings. `source` says where it came from:
`site` (with `site_id`), `package` (with `package_id`, `package_name`,
`version`, `publisher` and `verified`), `builtin` or `app` (with
`extension_id`). The package itself is not listed; `read_collection_entry`
returns it.

## Save to the collection

`save_to_collection` takes `kind` (`section`, `block_template`,
`page_template`, `global_block` or `block_type`), the site's `id` for it, and
an optional `name`, `description` and `category`. A block template becomes a
`section` or a `block_template` entry by its own kind. Only free global blocks
are saved; a header or footer belongs to its site.

```text
Save the "Opening hours" section of this site to our collection,
in the category Restaurants.
```

Links to the source site's pages become plain addresses, as in a package
export; `warnings` says so. Saving a block template also answers with
`design_findings`: its hard-coded colours and font families with the palette or
font role to use instead, so the entry follows the design of every site it is
inserted into (see [Colours and fonts](../packages/#colours-and-fonts)).

## Insert from the collection

`insert_from_collection` takes the `entry_id` and a `target`:

- `"library"` adds the block template, page template, global block or block
  type to the site. A whole package imports its content.
- `"page"` with a `page_id` places a section's, block template's or global
  block's blocks in the page's draft: after `after_block_id`, in that block's
  parent or slot when it is nested, or at `position` (top level, or within
  `parent_id` and `slot_index`). Without either, at the end. The blocks come
  the way copied blocks are pasted: the styles, block types, global blocks and
  images they use are added to the site, no template is. Save the page to
  publish the change.

Styles are **created on insert, never mapped**. Every style the entry uses is
created on the site. A style is reused only when the site has one with the same
id and the same definition; a differing one is created under a new id
(`hero-2`, named "Hero (imported)") and the inserted blocks are rewritten to
it. Block types and global blocks follow the same rule, and images are added to
the site's Media library, reusing a file with the same bytes. Nothing on the
site changes otherwise: an insert never touches the site's colours, fonts or
element styles.

A style the entry uses that neither the entry nor the site has is the one
exception: the site's standard style of the same role is used, with a warning
(see [Styles are created, not mapped](../packages/#styles-are-created-not-mapped)).

**Language.** An entry whose templates carry `translations` is inserted in the
site's language, or in the page's own language when you place it in a page
that has one. Only that language is written; the report's `template_languages`
says which was used. See [Text in the site's language](../packages/#text-in-the-sites-language).

**Text that names the site.** From render version 15 an entry's text can use
`{{site.name}}` and `{{site.fields.<name>}}`, which show the name and site
field values of the site it is inserted into.

**Placeholders.** Bracketed sample text such as `[Feature name]` in the
built-in starters is listed by the
[launch checklist](../../guides/launch-checklist/#placeholders) until it is
replaced.

The answer is `{ report, page? }`: the [package import report](../packages/#import_package)
(what was created, reused, renamed and replaced) and, for a page, its `id`, the
`added_ids` and the draft's `blocks`.

While a [handover](../../guides/handover/) locks a site's structure, placing
an entry in a page is refused for people without design rights
(`403 structure_locked`); the collection is not shown to them anyway.

## Add a package to the collection

`add_package_to_collection` takes a `.typeroll` file (`data_base64` or
`source_url`) and changes no site. A collection package becomes one entry per
block template, page template, free global block and block type, each with the
styles, block types, global blocks and media it depends on. A site package is
kept whole as one `package` entry. The package's menus, design, settings pages
and font files are not entries; import the package into a site to use them.
The answer is `{ entries, warnings }`. Each entry records the package, its
publisher and whether its signature was verified.

## Start a new site from a collection package

A `package` entry is a whole Site to start from. The portal's **New site**
page lists them under **Start from a template or another site**, with their
publisher and whether it is verified; with MCP, pass the entry id to
`create_site` as `from_collection_entry`. The same people who may use the
collection may start a Site from it (owners, administrators and builders).
Other kinds of entries answer `400` `package_not_a_site`: create the Site,
then insert them. See
[Start a site from a template or another site](../settings/#start-a-site-from-a-template-or-another-site)
for what is copied.

## Change and remove entries

`update_collection_entry` changes `name`, `description` or `category`; an empty
description or category removes it. `delete_collection_entry` removes an entry.
Sites it was inserted into keep their copies. Built-in entries answer `403`
with `collection_entry_read_only`.

## Apps

An app requests the `collection:read` and `collection:write` scopes in its
[manifest](../../extensions/manifest/). With them, its installation credential
lists the collection of the site's Organization and adds ready-made entries
with `POST /api/v1/sites/{siteId}/collection/import`. Those entries record
`source.type: "app"` and the app's `extension_id`, and the app may change or
remove only them (`403 collection_entry_not_owned` otherwise). An app cannot
save from a site or insert entries; people do that.

## REST endpoints

| Method and path                                                   | Body                                                        | Answer                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| `GET /api/v1/sites/{siteId}/collection`                           |                                                             | `{ entries }`                    |
| `GET /api/v1/sites/{siteId}/collection/{entryId}`                 |                                                             | `{ entry }` with its `package`   |
| `POST /api/v1/sites/{siteId}/collection/save`                     | `{ kind, id, name?, description?, category? }`              | `201 { entry, warnings }`        |
| `POST /api/v1/sites/{siteId}/collection/import`                   | `{ data_base64 \| source_url }`                             | `201 { entries, warnings }`      |
| `POST /api/v1/sites/{siteId}/collection/{entryId}/insert`         | `{ target: "library" }` or `{ target: "page", page_id, … }` | `{ report, page? }`              |
| `PATCH /api/v1/sites/{siteId}/collection/{entryId}`               | `{ name?, description?, category? }`                        | `{ entry }`                      |
| `DELETE /api/v1/sites/{siteId}/collection/{entryId}`              |                                                             | `{ deleted, id, files_removed }` |
| `GET /api/v1/sites/{siteId}/collection/{entryId}/media/{mediaId}` |                                                             | The preview image                |

The portal uses the same paths under `/api/sites/{siteId}/collection`, with a
multipart upload (`file`) for `import`. Refusals carry a `code`, such as
`collection_entry_not_found`, `collection_entry_read_only`,
`collection_entry_not_owned`, `collection_entry_not_insertable`,
`collection_full` (at most 2,000 entries), `collection_entry_too_large` and the
[package codes](../packages/#import_package).
