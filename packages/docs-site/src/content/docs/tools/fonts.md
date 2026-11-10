---
title: Font Tools
description: Find a font family, choose a family per role, upload licensed font files and use Adobe Fonts, Bunny Fonts or Fontshare.
---

These tools wrap `/api/v1/sites/{siteId}/fonts` and the `fonts` object of the
site settings. The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).
In the portal, fonts are chosen under **Settings → Design**.

## Roles

A site chooses one font family per role. Styles and blocks choose a role,
never a family, so changing a role restyles every style and block that uses
it, and a block template follows the site it is inserted into.

| Role      | Used for                     | When unset           |
| --------- | ---------------------------- | -------------------- |
| `heading` | H1–H6                        | `Inter`              |
| `body`    | Running text, links, buttons | `Inter`              |
| `mono`    | Code and preformatted text   | The system monospace |
| `display` | Large headings and heroes    | The heading family   |
| `accent`  | Eyebrows and quotes          | The body family      |

`display` and `accent` take effect from
[render version 15](../settings/#render-versions); they are available to
styles as `--font-display` and `--font-accent`. `system` as a family uses the
device's own fonts and downloads nothing.

## Where a family loads from

Typeroll looks up each family in this order:

1. The site's **Fonts library**: font files uploaded to the site.
2. A **font service** in `fonts.services`: an Adobe Fonts kit, or a Bunny
   Fonts or Fontshare stylesheet, loaded from the service's CDN.
3. `system`: no download.
4. Otherwise **Google Fonts**. The font catalog lists 250 open-licence Google
   families with their weights, italics and variable weight axis.

Google families are self-hosted by default (`fonts.delivery` unset or
`self_hosted`): Typeroll copies the font files while it prepares a
publication and publishes them on the site's own origin, so a visitor's
browser never contacts Google, also before any consent choice. With
`delivery: "google"` they load from the Google Fonts CDN, which sends each
visitor's IP address to Google. Delivery does not affect uploaded or service
fonts. See [the `fonts` object](../settings/#fonts-object).

## Weights in use

From render version 15 a publication loads only the weights and italics the
site uses: the weights in its styles, the weight settings of its blocks and
their defaults, and bold and italic rich text. Headings without a styled
weight are bold (700), body text always has 400, and no italic loads unless
the site has italic text. A variable family loads as one file covering the
range in use, and a self-hosted family gets a metric-matched fallback face so
text keeps its place while the font loads. Before render version 15 every
family loads 400–700.

From render version 17 the weights and italics written in CSS count too:
`font-weight`, `font-style` and the `font` shorthand in the site's and the
pages' custom CSS, a block's own custom CSS, the template and styles of the
site's own block types in use, and `<style>` elements and `style` attributes in
HTML. A rule whose `font-family` or `font` names a role
(`var(--font-heading)`, `--font-body`, `--font-display`, `--font-accent`,
`--font-mono`) loads the weight in that role; a rule for a heading element
(`h1`–`h6`) loads it in the heading family; any other rule loads it in both
the body and heading families, because either can inherit it. A `style`
attribute counts for its block's font. `bold` is 700, `normal` 400, and a
weight between the hundreds counts as the nearest hundred; `bolder`,
`lighter` and `var(...)` cannot be read and are not counted. In versions 15
and 16 CSS weights are not counted.

There is nothing to list for normal use. To load more, for example for a
weight that appears nowhere the planner reads (set by a script, or through a
CSS variable), add it per role with `fonts.load`:

```json
{
  "body": { "weights": [300], "italic": [400] },
  "heading": { "weights": [800] }
}
```

## The Fonts library

The Fonts library holds the site's own font files, separate from the media
library. It belongs to the site, not to a version: a branch uses the same
files. A site holds at most 60 files.

- WOFF2, WOFF, TTF and OTF files up to 10 MB, one font per file. Collections
  (`.ttc`) are refused; upload each font on its own.
- A file that is not WOFF2 is converted to WOFF2, which the site serves; the
  original is kept.
- Family, weight and style come from the file and can be corrected. A variable
  font covers a weight range, such as `100-900`. Upload one file per style
  (regular and italic) and, for static fonts, one per weight.
- `category` (`sans` or `serif`) chooses the metric-matched fallback: Arial or
  Times New Roman.
- **Licence confirmation is required.** Whoever uploads confirms that the
  font's licence allows use on this website, which usually takes a webfont
  or web licence; most desktop licences do not include it. Typeroll stores the
  confirmation with who gave it and when, and an optional note such as an
  order number.
- The same file cannot be uploaded twice.

Files are stored privately, in the organization's private media storage, and
copied into each publication, so a published site serves them from its own
origin. Deleting a file is allowed while a role uses its family; the response
names the roles, which fall back to Google Fonts or the fallback stack at the
next publication.

Uploading and deleting are design work: a site administrator or a
[builder](../../guides/teams-and-roles/#roles), like the font settings. Extension credentials can read the library but not change it.

Font files travel in a [package](../packages/#fonts-and-licences) only when the
exporter confirms their licence allows passing them on, and they are added to
another site's library only with the importer's own licence confirmation.
Adobe Fonts, Bunny Fonts and Fontshare kits never travel.

## Adobe Fonts, Bunny Fonts and Fontshare

`fonts.services` lists up to four services. Each loads a stylesheet from the
service's CDN and names the families it defines, which the roles can then
use:

```json
[
  {
    "provider": "adobe",
    "kit": "abc1234",
    "families": ["brand-sans", "brand-serif"]
  },
  {
    "provider": "bunny",
    "url": "https://fonts.bunny.net/css?family=lato:400,700",
    "families": ["Lato"]
  },
  {
    "provider": "fontshare",
    "url": "https://api.fontshare.com/v2/css?f[]=satoshi@400,700",
    "families": ["Satoshi"]
  }
]
```

- **Adobe Fonts**: `kit` is the web project ID from the embed code
  `https://use.typekit.net/<kit>.css`. Adobe's licence does not allow
  self-hosting, so the kit always loads from Adobe and cannot be uploaded to
  the Fonts library. Every visitor's browser contacts Adobe, which receives
  their IP address; mention Adobe Fonts in the site's privacy policy. The
  family names are the kit's CSS names, such as `brand-sans`.
- **Bunny Fonts** (`https://fonts.bunny.net/css…`) and **Fontshare**
  (`https://api.fontshare.com/v2/css…`): paste the stylesheet URL the service
  gives you.

The portal reads the stylesheet when a service is added and fills in
`families`. Over the API, read the family names from the stylesheet's
`font-family` declarations, or use the portal.

## `search_fonts`

Searches the font catalog and the site's own families. Exact names rank
first, then names starting with the query. Swedish, Norwegian, Danish,
Finnish and German are covered by every catalog family; `latin_ext` adds
Polish, Czech, Turkish and more.

| Parameter   | Type            | Description                                       |
| ----------- | --------------- | ------------------------------------------------- |
| `query`     | string          | Part of a family name                             |
| `category`  | string or array | `sans`, `serif`, `display`, `handwriting`, `mono` |
| `variable`  | boolean         | Only variable families                            |
| `italic`    | boolean         | Only families with italics                        |
| `latin_ext` | boolean         | Only families with the extended Latin subset      |
| `limit`     | integer         | Catalog results, 1–250 (default 50)               |

The result has three lists: `fonts` (catalog families with `weights`,
`italic`, `variable` and `latin_ext`, `source: "google"`), `library`
(uploaded families, `source: "upload"`) and `services` (service families,
`source: "service"`).

## `set_site_fonts`

Changes `fonts` in the site settings: `heading`, `body`, `mono`, `display`,
`accent`, `load`, `delivery` and `services`. Only the keys you pass change;
`null` clears `mono`, `display`, `accent`, `load`, `delivery` or `services`.
Pass `version` to change a branch instead of main. It needs design permission
(an administrator or builder), like `update_site_settings`, which accepts the same `fonts` object.

```json
{
  "heading": "Fraunces",
  "body": "Inter",
  "display": null,
  "load": { "body": { "weights": [300] } }
}
```

The response's `warnings` name any role family that is not in the catalog,
the Fonts library or a font service: it is requested from Google Fonts by
name and shows in the fallback font if Google does not have it.

## `upload_font`

Adds a font file to the Fonts library.

| Parameter           | Type             | Description                                                 |
| ------------------- | ---------------- | ----------------------------------------------------------- |
| `filename`          | string           | The file name; required with `data_base64`                  |
| `data_base64`       | string           | The file, base64-encoded                                    |
| `source_url`        | string           | An `https://` URL Typeroll downloads the file from, instead |
| `family`            | string           | Defaults to the family in the file                          |
| `weight`            | integer / string | `400`, or a range such as `"100-900"` for a variable font   |
| `style`             | string           | `normal` or `italic`; defaults to the file's style          |
| `category`          | string           | `sans` (default) or `serif`                                 |
| `licence_confirmed` | `true`           | Required: the licence allows use on this website            |
| `licence_note`      | string           | Where the licence comes from, such as an order number       |

Refusals carry a `code`: `font_unsupported` (not a font), `font_invalid`
(damaged), `font_collection`, `font_too_large`, `font_licence_required`,
`font_duplicate` and `font_library_full`.

## REST endpoints

| Method and path                                | Body or query                                                                 | Answer                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| `GET /api/v1/sites/{siteId}/fonts`             |                                                                               | `{ fonts, used_by }`                |
| `POST /api/v1/sites/{siteId}/fonts`            | `{ filename, data_base64 }` or `{ source_url }`, details, `licence_confirmed` | `201 { font }`                      |
| `GET /api/v1/sites/{siteId}/fonts/{fontId}`    |                                                                               | `{ font }`                          |
| `DELETE /api/v1/sites/{siteId}/fonts/{fontId}` |                                                                               | `{ deleted: true, warning? }`       |
| `GET /api/v1/sites/{siteId}/fonts/catalog`     | `query`, `category`, `variable`, `italic`, `latin_ext`, `limit`               | `{ fonts, library, services }`      |
| `PATCH /api/v1/sites/{siteId}/settings`        | `{ fonts: { … } }`                                                            | `{ ok, updated_fields, warnings? }` |

`used_by` maps each library family to the roles that use it in the site's
main settings. A library file looks like this:

```json
{
  "id": "4f1c2a9d0b7e3c5a8f6d2e1b",
  "family": "Brand Sans",
  "weight": [100, 900],
  "style": "normal",
  "category": "sans",
  "file": { "format": "woff2", "bytes": 48210, "sha256": "…", "key": "…" },
  "original": {
    "format": "ttf",
    "bytes": 112644,
    "sha256": "…",
    "key": "…",
    "name": "BrandSans-VF.ttf"
  },
  "licence": {
    "confirmed": true,
    "by": "editor@example.com",
    "at": "2026-11-07T10:00:00.000Z",
    "note": "Web licence, order 1234"
  },
  "created_at": "2026-11-07T10:00:00.000Z"
}
```

`font_plan` in a frozen publication's settings is derived when the
publication is prepared; the settings API refuses it as input.
