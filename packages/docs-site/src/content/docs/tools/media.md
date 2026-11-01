---
title: Media Tools
description: Upload images and other media through Typeroll’s media storage.
---

Media storage follows the selected Organization. Before customer storage is ready, uploads can use the configured Typeroll runtime storage. As soon as R2 is connected and verified, new uploads go directly to the Organization's storage. Public media hosts are applied during publishing. See [Publishing setup](../../guides/customer-publishing/).

## Direct file uploads through the API

Browsers, scripts and AI agents can upload a local file directly to the
Organization's R2. The WordPress helper plugin is not required.

1. Send `POST /api/v1/sites/{siteId}/media/upload-url`, authenticated with
   `Authorization: Bearer <API key>` and write permission:

   ```json
   {
     "filename": "photo.jpg",
     "content_type": "image/jpeg",
     "size": 123456,
     "alt_text": "Describe the image"
   }
   ```

2. Send the file bytes with `PUT` to the returned `upload_url`, using the same
   `Content-Type`. Do not send your Typeroll API key to this URL. It is a temporary
   grant for this one object; the client does not need R2 credentials.
3. After a successful upload, send `POST` to the returned `finalize_url`, with
   your Typeroll API key. Wait for successful verification before using the asset.
   Keep the returned `media_id`; do not construct a media URL yourself. The
   returned `filename` is the stored name; see
   [file names and types](#file-names-and-types).

With verified Organization storage, the upload goes from the client to R2 and
Core 0.1.97 verifies it in the customer's Cloudflare account. Typeroll handles
permissions, metadata and status. Responsive variants are prepared separately.
The selected GitHub or Cloudflare build provider does not change this route.

For an import, check the storage prerequisite below **before requesting upload
URLs or creating content**. Ordinary newly authored uploads may use draft
runtime storage before Organization storage is connected. That allowance must
not be used to bypass the import prerequisite. For files already available at a
public URL, use the URL-import endpoint below; the agent does not need to download
and re-upload their bytes.

## SVG files

An SVG opened directly from the media host or the website is a document in which
browsers can run script. Typeroll therefore stores SVG only in sanitized form:
finalize, and every URL or WordPress import, rewrites the file as static vector
graphics before it is stored or published. Files with the type `image/svg+xml`
(or another XML type) or a filename ending in `.svg` are treated as SVG and are
stored as `image/svg+xml`.

- **Kept:** shapes, paths, text, groups, `<symbol>` and `<use>` with in-document
  `#id` references, gradients, patterns, clip paths, masks, markers, common
  filter primitives, `<title>` and `<desc>`, `<style>` and `style` CSS, animation
  of presentation attributes, and raster images embedded as
  `data:image/png|jpeg|gif|webp|avif;base64`.
- **Removed:** scripts, event handler attributes, `<foreignObject>`, links (the
  link's content stays), DOCTYPE and entity declarations, processing
  instructions, comments, editor metadata, any `href` that is not an in-document
  `#id`, CSS `url()` that does not point to an `#id`, `@import`, and animation of
  links or event handlers.
- **Rejected:** a file that is not a well-formed SVG document, such as HTML, XML
  whose root is not `<svg>` or compressed `.svgz`, returns HTTP 400 with
  `media_svg_invalid`. A truncated SVG returns 422 like other corrupted uploads.
  Nothing is published; export the file again and upload it.

The stored bytes differ from the uploaded bytes. For an SVG, finalize returns the
`sha256` and `size_bytes` of the stored file together with `svg_sanitized: true`,
`source_sha256` (the file you sent) and `removed` (the kinds of content that were
removed). `expected_sha256` is still the hash of the file you sent, also on retries.

Sites that use the server's platform storage instead of Organization storage
stage SVG uploads in a private bucket, because every object in the public bucket
is reachable as soon as it is written. The sanitized file appears at `cdn_url`
after finalize. On a self-hosted server the private bucket is `R2_PRIVATE_BUCKET`;
without it, SVG uploads return 503 with `svg_staging_unavailable`. SVGs stored in
that public bucket earlier are sanitized in place once, by their next finalize
or by the backfill that runs when a site is deployed; later deploys skip files
that already hold their recorded sanitized bytes, and a dry run changes nothing.
A file that cannot be sanitized is served only as a download when it contains
anything that could run or load content (scripts, event handlers, `javascript:`
URLs, `<foreignObject>`, entity declarations, style sheets, external `href`
values or a non-UTF-8 encoding). Otherwise it stays as it is, so an existing
logo keeps displaying. Either way each deploy lists the file in `job.warnings`
until you replace it with a plain SVG.

The rewrite changes the bytes at an existing public URL. CDNs and browsers may
keep serving the previous bytes until their cached copy expires, up to the
cache lifetime of the original response (platform uploads are cached for up
to a year). After the first deploy on Core 0.2.113, purge the media host's
CDN cache, or at least those SVG URLs, so the sanitized files are served
everywhere.
SVGs that were stored in Organization or draft storage before sanitizing existed
are sanitized when they move to Organization storage and, at the latest, when a
publication references them: publishing stores a sanitized copy as a new
original and publishes that. A dry-run publication checks these files without
storing anything. An SVG that cannot be sanitized is left out of the
publication: its bytes are not published, references to it in pages become
empty, and the rest of the site is published. The deploy job lists each
excluded file in `job.warnings` (`get_deploy_status`, Deploy history), naming
the media ID and filename; upload a plain SVG, select it instead and publish
again. Preparing a domain change rebuilds the last publication exactly, so it
stops with HTTP 409 and `media_svg_unsanitized` while that publication contains
an unsanitized SVG; publish the site once first. Typeroll never publishes an SVG
that was not sanitized.

In the Media library, the media picker and chat attachments, a file that finalize
refuses because of the file itself (`media_svg_invalid`,
`media_extension_mismatch`, HTTP 415 or 422) is removed again and the reason is
shown, instead of leaving a broken item in the library. A concurrent change
(`media_revision_conflict`) or a rate limit is retried; other errors, such as
an expired sign-in, keep the uploaded file and show the reason.

## File names and types

When media is published on the website host, the static host chooses each file's
`Content-Type` from its extension. A filename or `public_path` must therefore end
in an extension that belongs to the file's type. Extensions are compared without
regard to case.

| Type                                       | Allowed extensions               |
| ------------------------------------------ | -------------------------------- |
| `image/jpeg`                               | `.jpg`, `.jpeg`, `.jpe`, `.jfif` |
| `image/png`                                | `.png`                           |
| `image/apng`                               | `.apng`, `.png`                  |
| `image/gif`                                | `.gif`                           |
| `image/webp`                               | `.webp`                          |
| `image/avif`                               | `.avif`                          |
| `image/svg+xml`                            | `.svg` (stored only sanitized)   |
| `image/x-icon`, `image/vnd.microsoft.icon` | `.ico`                           |
| `image/bmp`                                | `.bmp`                           |
| `image/tiff`                               | `.tif`, `.tiff`                  |
| `image/heic`, `image/heif`                 | `.heic`, `.heif`                 |
| `image/jxl`                                | `.jxl`                           |
| `application/pdf`                          | `.pdf`                           |

Uploads accept images and PDFs of these types. Records from earlier imports can
also be video (`.mp4`, `.m4v`, `.webm`, `.mov`), audio (`.mp3`, `.wav`, `.ogg`) or
fonts (`.woff`, `.woff2`).

- Uploads and imports (`upload-url`, `create_upload_url`, `upload_media_*`,
  URL and WordPress imports) append the type's canonical extension when the
  filename has no extension or one that belongs to another type: `logo`
  uploaded as `image/png` is stored as `logo.png`, `photo.html` as
  `photo.html.png`, and `render.php` imported as `image/png` as
  `render.php.png`. The response's `filename` is the stored name. Types outside
  the table return HTTP 415 with `media_type_unsupported`, and nothing is
  created.
- Renames are not corrected. `PATCH /api/v1/sites/{siteId}/media/{mediaId}`
  (`update_media`) and the Media library return HTTP 400 with
  `media_extension_mismatch` when a changed `filename` or `public_path` does not
  end in an extension of the stored type. Unchanged values are accepted, so
  older records stay editable.
- Publishing never serves a file under an extension that does not match its type.
  An older record whose name or `public_path` does not match is published with
  the type's extension appended, for example `/photo.html.png`, and its page
  references are rewritten to that address. A record of any other type is
  published as a download with `.bin` appended. Earlier publications' files
  with mismatched names, or unsanitized SVGs, are not published again.

Published websites send `X-Content-Type-Options: nosniff` for every file. Files
ending in `.svg`, `.SVG`, `.svgz`, `.xhtml` or `.xht` also receive
`Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:`,
so an SVG opened directly cannot run script on the website's address. SVGs used
in `<img>` or CSS display as before. PDFs are not sandboxed, so browsers keep
showing them inline.

## `get_import_readiness`

Available with Core 0.1.95 and MCP 0.44.68. Call before starting an import. Returns
`ready`, `message`, `code` and `settings_url`. Imports return HTTP 409 with
`import_storage_required` until the organization’s own storage is verified.

The public API exposes the same check at
`GET /api/v1/sites/{siteId}/media/import`. Submit an import with:

```json
{
  "source_url": "https://old.example.com/uploads/photo.jpg",
  "filename": "photo.jpg",
  "content_type": "image/jpeg",
  "alt_text": "Describe the image"
}
```

Send this JSON to `POST /api/v1/sites/{siteId}/media/import` with your site or
organization API key. Only write access may import; the authenticated site’s
owning organization determines the destination. For extensionless source URLs,
provide `filename` and `content_type`. Completed imports are reused on retry.

For many files, send up to four import requests at a time; Typeroll copies up to
four files from one source host at once. A source path with characters such as
`ä` is tried as written and in both Unicode forms (NFC and NFD), so send the URL
as it appears on the old site. Publishing still verifies each file into the
public site, so the first publication after a large import spends time in
`preparing_media`.

## `upload_media_from_url`

Requires verified organization storage. With Core 0.1.97 and MCP 0.44.68 or later, submits the source URL to the customer’s transfer Worker. Neither the portal nor MCP downloads the file body. Returns the stored asset and its stable media URL; private originals require authenticated access.

```
Upload the hero image from https://unsplash.com/... as the OG image for the homepage.
```

The AI agent uses this when importing content from external sources (WordPress, Squarespace, etc.) to transfer images through Typeroll’s media storage.

## `upload_media_from_base64`

Uploads an image provided as a base64-encoded string. Useful when the image is generated locally or provided as a data URI.

## `get_media_upload_status`

The same pre-flight the portal media library uses for its banner: whether
uploads can go through for this site right now. Returns `enabled`, and when
uploads are unavailable a `reason` plus either `settings_url` (Organization
storage needs attention) or `missing` (self-hosted platform storage variables
absent on the server). Read access is enough. Over REST:
`GET /api/v1/sites/{siteId}/media/upload-status`.

Use [`get_import_readiness`](#get_import_readiness) before an import; it applies
the stricter import prerequisite.

## `list_media`

Returns this site’s media assets with stable media URLs, filenames and sizes. A stable URL can identify a private original; it is not necessarily a public delivery URL.

## `read_media`

Reads one media item's metadata by `media_id`. Use it to check a single file,
for example its alt text or variants, without listing the whole library.

## `upload_media_inline`

Uploads an image or PDF from base64 bytes: `filename`, `content_type`,
`data_base64` and an optional `alt_text`. Use it only for files of a few
kilobytes. Base64 text that passes through a model can be altered without an
error, which leaves a file that uploads at the right size but renders broken.
For anything larger, and always for SVG files, logos and generated images, use
[direct file uploads](#direct-file-uploads-through-the-api) or
[`upload_media_from_url`](#upload_media_from_url), then render the result
before you reference it. Returns `media_id`, `cdn_url` and `filename`.

## `finalize_media`

Call after a successful direct upload of an image. It sets a one-year immutable
`Cache-Control` on the stored original and generates AVIF and WebP variants if
they are missing. It is safe to call twice. Pass `expected_sha256` (the SHA-256
of your source file) so a corrupted transfer is rejected with HTTP 422 instead
of being cached. The response includes the stored `sha256` and `size_bytes`.
Truncated SVG files are rejected.

## `finalize_all_media`

Applies the same cache headers and variants to every item in the library that
lacks them. Use it once on an older site. It runs synchronously, can take
minutes on a large library and is idempotent.

## `generate_image_variants`

Regenerates the WebP and AVIF variants (320, 640, 1024 and 1920 pixels wide,
never upscaled) for one image. Non-image files are skipped. Prefer
`finalize_media` for new uploads; use this tool only to rerun variants.

## `suggest_alt_text_context`

Returns what an agent needs to write alt text for one image: the image URL, a
prompt tuned for accessibility and search, the site language and the pages that
use the image, with the nearest heading for each use. It does not generate the
text. Your agent writes it and saves it with `update_media`.

## `delete_media`

Deletes a media item's record by `media_id`. Check where the file is used
first; pages that still reference it lose the image.

## Media URLs

Use the stable URL returned by the media API instead of constructing an address. A URL ending in `/api/sites/{site}/media/{id}/content` requires authenticated Site access because it identifies a private original: a portal session, or the same `Authorization: Bearer` API key (site or organization) as `/api/v1`, which receives a 302 to a short-lived signed address. Typeroll authorizes images temporarily for previews and resolves public delivery URLs during publishing. Public visitors should never need to log in. Use the returned stable URL in:

- `<img src>` attributes in page HTML
- `og_image` and `logo` settings fields
- Page custom fields of type `image`

Do not leave imported content dependent on the original source host. Transfer its media before retiring that host. During publishing, Typeroll includes referenced public media in static output and resolves the Site's preferred media host and paths while preserving shared aliases. See [Website and media domains](../../publishing/domains/).

With Core 0.2.0, publishing stops with `media_reference_unresolved` if an internal
media address cannot be resolved to a public file. The error identifies the
media record to repair. Re-select the asset from this Site’s Media library, or
re-import it if it belongs to another Site or no longer exists. Retry publishing
after the reference is corrected. Do not make the private originals bucket public.

Preview readiness and public availability are different checks. Verify the
finished site without a Typeroll session, including responsive images, CSS
backgrounds and file downloads, before retiring the import source.

### Published address of a file

The published file name is derived from the content hash and a cleaned file
name, so do not compute it yourself. After each successful publication of the
`main` version, every media record carries:

- `published_url`: the absolute URL at which that publication serves the file.
- `published_path`: the path of `published_url` on its host. That host is the
  website when media is served from the site (for example `/media/…`), otherwise
  the Site's media host.

Both are `null` when the latest `main` publication contains no reference to the
file, and absent until the file has been published once. Version (branch)
publications do not change them. Use `published_url` as the target when you
redirect old file addresses after a migration. It changes only when a later
publication serves the file at another address. Responsive variants are
generated from the published file and are not listed separately.

`source_aliases` lists every address the file has had: the original source URL,
earlier storage, CDN and published addresses, and their image variants. It only
grows. Publishing rewrites any of these addresses found in content to the file's
current address, so content that still links to an old address keeps working
without edits. Earlier publications' files also remain available at their old
addresses. The order of `source_aliases` is not significant; read
`published_url` for the current address.

## Image recommendations

| Use                 | Recommended size                              |
| ------------------- | --------------------------------------------- |
| Hero images         | 1920×1080px or 1600×900px                     |
| Open Graph / social | 1200×630px                                    |
| Card thumbnails     | 800×600px                                     |
| Logo                | SVG preferred; PNG at 2× if SVG not available |
| Favicon             | 32×32px PNG or ICO                            |

Typeroll doesn't resize images at serve time. Use appropriately-sized source images.

## Background preparation

With Core 0.1.93, `get_media_preparation` reports private image preparation status,
completed files, total files and any issue requiring attention. `prepare_media`
queues or retries preparation and requires Site admin permission. This does not
publish a site. REST clients use `GET` and `POST` on
`/api/v1/sites/{site}/media/preparation`; `list_media` also includes preparation
status. The Organization's selected, updated shared build engine performs this
work. Original files and prepared draft variants remain private until publication.

Uploads and imports share one preparation job per Site. The job starts once no
new upload has arrived for 30 seconds, and at most five minutes after the first
upload it waits for, so a series of single-file imports or
`upload_media_batch_from_urls` calls becomes one build job instead of one per
file. Files uploaded while a job runs are prepared together in the next round.
`prepare_media` starts at once. While a preparation job runs, it occupies the
Organization's shared build engine like any other build.

## Responsive image resolution (Core 0.2.37+)

Static publishing and explicit variant generation create AVIF and WebP images
at the supported smaller widths and at the original image width. Exact preset
widths are included once; small originals also receive a full-width candidate.
Typeroll never enlarges the generated pixels. A layout wider than the original
can still enlarge it on screen, so upload enough resolution for its intended use.

This prevents a modern browser from selecting a smaller image just because its
chosen `<picture>` format lacks the original width. Changing `sizes` alone cannot
recover missing pixels. Previewing the original is not a substitute for checking
the published derivative at the intended viewport and pixel density.

Existing sites adopt this on their next publication. The new `v2` preparation
recipe uses separate immutable cache addresses; the first publication prepares
new variants once. Later unchanged builds keep reusing their verified receipts
and files. Old published image addresses and original files are preserved. For
independent workflows that explicitly generate variants through the API/MCP, run
variant generation again before rebuilding; no customer CSS patch is needed.

### Older image variants during publication

From Core 0.2.38, an older generated AVIF/WebP URL may remain available while
the same original image is still included unchanged in the website. This does
not block publication when the image recipe changes. New pages use the new
variants. Removing or replacing the original still requires the corresponding
public removal checks to pass; this is not a general exception for deleted media.

## `purge_site_media`

Permanently deletes every media object and record of an **archived** site, from
the organization's storage — the media step of retiring a site for good. It is
irreversible, so it has two preconditions:

- The site must be archived first (`archive_site`, see
  [Archive a site](../../guides/archive-a-site/)). An active site returns HTTP 409.
- The caller must be an admin of the organization that owns the site: a site API
  key or an organization key of the owning organization. Shared access is
  refused.

The response counts `records`, `objects_deleted`, `records_removed` and
`records_retained`. When some objects cannot be removed the call answers HTTP 207
and lists them in `failed`; their records are kept so nothing becomes
untraceable, and calling again retries exactly those. Over REST:
`POST /api/v1/sites/{siteId}/media/purge`.
