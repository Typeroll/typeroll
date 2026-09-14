---
title: Media Tools
description: Upload images and other media through Typeroll’s media storage.
---

Media storage follows the selected Organization. Before customer storage is ready, uploads can use the configured Typeroll runtime storage. After verified R2 setup and migration, new uploads use the Organization's storage and media host. See [Publishing setup](../../guides/customer-publishing/).

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

Requires verified organization storage. With Core 0.1.95 and MCP 0.44.68, submits the source URL to the customer’s transfer Worker. Neither the portal nor MCP downloads the file body. Returns the stored asset and its stable media URL; private originals require authenticated access.

```
Upload the hero image from https://unsplash.com/... as the OG image for the homepage.
```

The AI agent uses this when importing content from external sources (WordPress, Squarespace, etc.) to transfer images through Typeroll’s media storage.

## `upload_media_from_base64`

Uploads an image provided as a base64-encoded string. Useful when the image is generated locally or provided as a data URI.

## `list_media`

Returns all media assets for this site with their public URLs, filenames and sizes.

## Media URLs

Use the absolute URL returned by the media API rather than constructing a `cdn.typeroll.com` address. The host depends on the Organization's configuration. Use the returned URL in:

- `<img src>` attributes in page HTML
- `og_image` and `logo` settings fields
- Collection item `image` fields

Do not leave imported content dependent on the original source host. Transfer its media before retiring that host. During publishing, Typeroll includes referenced public media in static output and resolves the Site's preferred media host and paths while preserving shared aliases. See [Website and media domains](../../publishing/domains/).

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
