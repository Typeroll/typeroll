---
title: Media Tools
description: Upload images and other media to the Typeroll CDN.
---

Media is stored on Cloudflare R2 and served via `cdn.typeroll.com`.

## `upload_media_from_url`

Fetches an image from a URL and uploads it to the CDN. Returns the CDN URL.

```
Upload the hero image from https://unsplash.com/... as the OG image for the homepage.
```

Claude uses this when importing content from external sources (WordPress, Squarespace, etc.) to transfer images to the Typeroll CDN.

## `upload_media_from_base64`

Uploads an image provided as a base64-encoded string. Useful when the image is generated locally or provided as a data URI.

## `list_media`

Returns all media assets for this site with their CDN URLs, filenames and sizes.

## CDN URLs

All CDN URLs are absolute (`https://cdn.typeroll.com/...`). Always use these in:

- `<img src>` attributes in page HTML
- `og_image` and `logo` settings fields
- Collection item `image` fields

Never use relative paths or the original source URL — those won't survive a deploy.

## Image recommendations

| Use                 | Recommended size                              |
| ------------------- | --------------------------------------------- |
| Hero images         | 1920×1080px or 1600×900px                     |
| Open Graph / social | 1200×630px                                    |
| Card thumbnails     | 800×600px                                     |
| Logo                | SVG preferred; PNG at 2× if SVG not available |
| Favicon             | 32×32px PNG or ICO                            |

Typeroll doesn't resize images at serve time. Use appropriately-sized source images.
