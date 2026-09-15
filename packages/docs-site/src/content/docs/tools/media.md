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
   Keep the returned `media_id`; do not construct a media URL yourself.

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

## `upload_media_from_url`

Requires verified organization storage. With Core 0.1.97 and MCP 0.44.68 or later, submits the source URL to the customer’s transfer Worker. Neither the portal nor MCP downloads the file body. Returns the stored asset and its stable media URL; private originals require authenticated access.

```
Upload the hero image from https://unsplash.com/... as the OG image for the homepage.
```

The AI agent uses this when importing content from external sources (WordPress, Squarespace, etc.) to transfer images through Typeroll’s media storage.

## `upload_media_from_base64`

Uploads an image provided as a base64-encoded string. Useful when the image is generated locally or provided as a data URI.

## `list_media`

Returns this site’s media assets with stable media URLs, filenames and sizes. A stable URL can identify a private original; it is not necessarily a public delivery URL.

## Media URLs

Use the stable URL returned by the media API instead of constructing an address. A URL ending in `/api/sites/{site}/media/{id}/content` requires authenticated Site access because it identifies a private original. Typeroll authorizes images temporarily for previews and resolves public delivery URLs during publishing. Public visitors should never need to log in. Use the returned stable URL in:

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
