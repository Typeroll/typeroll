---
title: Package Tools
description: Move templates, sections, global blocks, block types, styles, the design and whole sites between sites as one .typeroll file, including packages bought from someone else.
---

These tools wrap `/api/v1/sites/{siteId}/packages`.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

A Typeroll package (`.typeroll`) is one file that carries block templates
(sections), page templates, global blocks, site block types, styles, the
design (colours, typography, scales, content widths and font roles), menus,
site field definitions, media and, when the author may pass them on, font
files. A site package carries a whole site.

Within one Organization, the [organization collection](../collection/) keeps
templates, sections and block types ready for every site; it stores each entry
as a single-entry package and can take in a `.typeroll` file.

A package belongs to no organization. It holds no organization or site ids,
and its media and font files travel inside it, so anyone can import it into
their own site: a template pack bought from a studio, sections shared by a
colleague, or a starter site. The content export in
[Export and backup](../../guides/export-and-backup/) is separate: it is the
complete site as JSON for backups and the open-source renderer, and it is not
imported.

## Kinds

| `kind`       | Holds                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `collection` | What the author chose: templates, page templates, free global blocks, block types, styles, design, menus      |
| `site`       | A whole site: pages (published, unlisted and drafts), header and footer, menus, site fields with their values |
| `clipboard`  | Blocks copied from a page, with the styles, block types and media they use                                    |

What the chosen content uses comes along by itself: the free global blocks it
places, the site block types it uses (and those they build on), and the
styles it uses.

## The file

A package is a zip with a manifest and its files:

```text
typeroll.json            the manifest
media/<sha256>.<ext>     media files
fonts/<sha256>.woff2     font files the author may pass on
```

The manifest lists the sha256 of every file. Import refuses a package whose
files do not match, that is missing a file or carries one more, that holds
anything outside these paths, or that breaks a limit:

| Limit                         | Value  |
| ----------------------------- | ------ |
| Package file                  | 200 MB |
| Unpacked files in total       | 400 MB |
| Manifest                      | 20 MB  |
| Entries                       | 5,000  |
| Media files                   | 2,000  |
| One media file in a package   | 50 MB  |
| One file in the Media library | 25 MB  |
| Font files                    | 60     |
| Block templates               | 500    |
| Page templates                | 100    |
| Global blocks                 | 200    |
| Block types                   | 200    |
| Styles                        | 300    |
| Menus                         | 50     |
| Pages                         | 2,000  |

## What travels

**Media.** Every image or file the exported content uses goes into the
package. In content, its address becomes a token, `typeroll-media:<id>`. Import
adds each file to the site's Media library through the normal private upload
path and replaces the tokens with the new addresses. A file the library
already has, with the same bytes, is reused.

The author can mark files as **demo content** (`demo_media`). Imported demo
files carry a demo badge in the Media library, and the
[launch checklist](../../guides/launch-checklist/#demo-media) and the
publication list them while live pages use them, so they are replaced before
the site launches. Keeping a file clears the flag: send `demo: false` with
`PUT /api/sites/{siteId}/media/{mediaId}` or
`PATCH /api/v1/sites/{siteId}/media/{mediaId}`.

**Links.** A collection keeps links to the author's pages only as plain
addresses, empties lists of chosen pages and leaves menu items that point at
pages out, with a warning. A site package keeps them and points them at the
imported pages.

**App blocks.** Blocks of an installed app are named by the app
(`app:<extension id>/<component>`), not by the author's installation. On a site
with the same app they connect to its installation; without it they show
nothing until the app is installed, with a warning.

**Not in a package:** form submissions, API keys, secrets, domains,
publishing connections, members, revisions, content types and HTML pages.

## Fonts and licences

- **Catalog families** (Google Fonts) need no files: the design names them and
  import sets the roles.
- **Uploaded font files** go into the package only when the exporter confirms
  that their licence allows passing them on (`redistributable_confirmed:
true`). Most commercial licences do not; leave them out and the package keeps
  only the family names.
- **Importing font files** needs the importer's confirmation too
  (`font_licence_confirmed: true`): the font's licence must allow use on their
  website. It is stored with the file in the [Fonts library](../fonts/#the-fonts-library),
  with who confirmed it.
- **Adobe Fonts, Bunny Fonts and Fontshare** never transfer. The package names
  the families; a buyer adds their own kit or stylesheet, or chooses other
  fonts. The import warns about it.

## Styles are created, not mapped

Import never swaps a package's styles for the site's "nearest" styles. Every
style the imported content uses is created on the site, so the imported design
stays as the author made it and can then be changed site-wide:

- A style the site already has with the **same id and the same definition** is
  reused.
- A style with the same id but **another definition** is created under a new
  id, such as `hero-2`, named "Hero (imported)", and the imported content is
  rewritten to it. The site's own `hero` is unchanged.
- Renaming a style later changes only its display name; ids stay.
- A standard role (for example `lead`) is held by one style per site: an
  imported copy beside the site's own is a plain class style.

## Design modes

`options.design` decides how much of the package's look an import takes:

| Mode      | Adds                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `content` | The blocks and every style they use (the default)                                                                                     |
| `styles`  | Also the package's other class styles                                                                                                 |
| `full`    | Also the element styles (body, h1–h6, link), replacing the site's, and the colours, typography, scales, content widths and font roles |

`full` changes the whole site's look, so it needs design permission (a site
administrator or a [builder](../../guides/teams-and-roles/#roles)), like the
design settings. `fonts: false` imports the full design without the font roles and
files.

## Conflicts and renames

Block types, block templates, page templates, global blocks, menus and pages
follow the same rule as styles: an identical block type is reused, anything
else that collides gets a free id (`hero-2`) and every reference in the
imported content follows. A site package's header and footer replace the
site's. A page whose address is taken is imported at a free address
(`/about-2`); a second homepage is not imported. A menu location the site
already fills is left off the imported menu. A settings page whose id the site
already uses with other fields is skipped.

The whole import is planned and checked before anything is written. If a write
fails part-way, the import stops with `package_import_partial` and
`details.report` lists what was written.

## Signatures and trusted publishers

A package can be signed by its publisher (Ed25519 over the manifest, which
lists the sha256 of every file). Inspecting shows `signature.status`:

| Status        | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `verified`    | A publisher this portal trusts signed it; `publisher` names them |
| `unsigned`    | No signature; the author named in the package is not verified    |
| `unknown_key` | Signed with a key this portal does not know                      |
| `invalid`     | The package was changed after it was signed                      |

Unsigned packages can be imported; the author they name is shown as
unverified. A self-hosted portal lists the publishers it trusts in
`TYPEROLL_PACKAGE_TRUSTED_KEYS`, a JSON list of
`{ "key_id", "publisher", "public_jwk" }`.

## Buying packages from others

A package from someone else is checked like any other input: its files must
match their sha256, its block trees, styles, menus and block types are
validated, and SVG files are sanitized as uploads are. Before importing:

1. Inspect it (`inspect_package`, or **Packages** in the portal) and read the
   plan, the warnings and the licence it names.
2. Choose the design mode. Start with `content` to add sections without
   changing the site's look.
3. Confirm font licences only when you hold one for your website.
4. Replace the demo images before publishing.

## `export_package`

Export part of the site, or the whole site, and get a signed download address
valid for one hour. A collection needs write permission; a site package needs
admin, like the content export.

```json
{
  "selection": {
    "kind": "collection",
    "block_templates": ["hero", "pricing"],
    "styles": "used",
    "design": true,
    "fonts": { "families": ["Brand Sans"], "redistributable_confirmed": true },
    "demo_media": ["3f2c…"]
  },
  "meta": {
    "id": "acme-restaurant-sections",
    "name": "Acme restaurant sections",
    "version": "1.0.0",
    "author": { "name": "Acme Studio", "url": "https://acme.example" },
    "licence": { "name": "Commercial, one site" },
    "languages": ["en"]
  }
}
```

`block_templates`, `page_templates`, `global_blocks`, `block_types` and
`menus` take a list of ids or `"all"`; `styles` is `"used"` (default) or
`"all"`; `site_fields` adds the settings page definitions. `kind: "site"`
takes everything. The answer is
`{ download_url, filename, bytes, sha256, expires_at, warnings }`.

## `inspect_package`

Read a package and show what importing it would do, without changing
anything. Send `data_base64` (at most 32 MB) or `source_url` (an `https://`
address, up to 200 MB) and `options`. The answer is
`{ package, signature, plan, warnings, errors, needs }`: the plan lists each
style, block type, template, global block, menu, page and media file with its
action (`create`, `reuse`, `rename`, `replace`, `skip`), and the id maps.
`errors` lists what would stop the import; `needs` says whether it needs design
permission (`design`, also reported as `admin` for older callers) and a font
licence confirmation.

## `import_package`

Import a package. The same body as `inspect_package`, with `options`:

| Option                   | Type     | Meaning                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------ |
| `design`                 | string   | `content` (default), `styles` or `full`                            |
| `fonts`                  | boolean  | With `full`: import the font roles and files (default `true`)      |
| `only`                   | string[] | Only these entries, such as `block_templates.hero` or `menus.main` |
| `font_licence_confirmed` | `true`   | Required when the import adds font files                           |

The answer is `{ report }` with what was `created`, `reused`, `renamed`,
`replaced` and `skipped`, the design keys updated, counts and warnings.
Imported block templates record where they came from in `imported_from`
(package id, name, version, author and time).

Refusals carry a `code`: `package_invalid`, `package_too_large`,
`package_unsafe`, `package_integrity_failed`, `package_conflict` (with
`details.errors`), `package_permission`, `font_licence_required`,
`font_redistribution_unconfirmed`, `package_selection_invalid`,
`package_source_unavailable` and `package_import_partial`.

## REST endpoints

| Method and path                                         | Body                                      | Answer                                                            |
| ------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/v1/sites/{siteId}/packages/export`           | `{ selection, meta }`                     | `{ download_url, filename, bytes, sha256, expires_at, warnings }` |
| `GET /api/v1/sites/{siteId}/packages/downloads/{token}` |                                           | The `.typeroll` file (the signed token is the credential)         |
| `POST /api/v1/sites/{siteId}/packages/inspect`          | `{ data_base64 \| source_url, options? }` | `{ package, signature, plan, warnings, errors, needs }`           |
| `POST /api/v1/sites/{siteId}/packages/import`           | `{ data_base64 \| source_url, options }`  | `{ report }`                                                      |

The portal uses session routes with the same rules:
`POST /api/sites/{siteId}/packages/export` answers with the file itself
(`application/vnd.typeroll.package+zip`), `inspect` and `import` take a
multipart upload (`file` and `options` as JSON), and
`GET /api/sites/{siteId}/packages/exportable` lists what the export form can
offer. Extension credentials cannot export or import packages.
