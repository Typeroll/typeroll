---
title: Media Tools
description: Upload images and other media through Typeroll’s media storage.
---

Media storage follows the selected Organization. Before customer storage is ready, uploads can use the configured Typeroll runtime storage. After verified R2 setup and migration, new uploads use the Organization's storage and media host. See [Publishing setup](../../guides/customer-publishing/).

## `upload_media_from_url`

Fetches an image from a URL and uploads it through the media API. Returns the stored asset and its public URL.

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
