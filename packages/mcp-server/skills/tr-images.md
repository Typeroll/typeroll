---
name: tr-images
description: Use when the user asks for an image, hero, illustration, or logo to be created and embedded in a Typeroll page. Covers the two-step signed-URL upload flow so the agent doesn't try to POST bytes through the CMS API (it can't).
---

# Add images to a Typeroll site

The Typeroll API does NOT accept image bytes directly. Uploads go
through a signed PUT URL straight to Cloudflare R2, and the API only
sees the metadata. Two-step flow:

## Recipe

### 1. Get an image

Options, in order of preference:

a. **Reuse an existing one.** `list_media` returns CDN URLs for every
   image already on this site. Search the list before generating
   anything — saves bandwidth and keeps the visual catalog tight.

b. **Generate locally.** The user's Claude Code installation has
   access to whatever image-gen tools they've configured (DALL-E,
   Midjourney, Stable Diffusion, Replicate, etc.). Generate and save
   to a tempfile.

c. **Source from the web** with appropriate licensing (the user is
   responsible for clearing rights). Save locally before upload.

### 2. Mint a signed upload URL

```
create_upload_url filename="hero-services.png"
                  content_type="image/png"
                  size=<bytes>
                  alt_text="Office worker reviewing documents at a desk"
```

Returns:

```json
{
  "upload_url": "https://...r2.cloudflarestorage.com/.../signed-...",
  "cdn_url": "https://cdn.example.com/orgs/.../images/...png",
  "key": "orgs/.../images/...png",
  "media_id": "abc123",
  "expires_in": 300
}
```

The signed URL is valid for 5 minutes. The media doc is already
registered — even before the upload completes — so it'll show in
`list_media` immediately.

### 3. PUT the bytes

Outside the MCP, hit the signed URL directly:

```
PUT <upload_url>
Content-Type: <same content_type as in step 2>
Body: <file bytes>
```

In a shell:

```bash
curl -sS -X PUT --data-binary @hero-services.png "$UPLOAD_URL"
```

Optionally with `-H "Content-Type: image/png"` if you need to override what R2 will infer. **Nothing else.**

> The signed URL embeds checksum-related query parameters
> (`x-amz-checksum-crc32`, `x-amz-sdk-checksum-algorithm`) for legacy
> SDK compatibility, but `X-Amz-SignedHeaders=host` — only the host
> header is part of the signature. Sending the `x-amz-*` values as
> request headers yields `403 SignatureDoesNotMatch`. Don't. Just
> `--data-binary` the file at the URL.

Or from JS (Claude Code can run a one-line script):

```js
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': contentType },
  body: await fs.readFile(path),
});
```

Parallelise N uploads via shell `&` + `wait`:

```bash
while IFS=$'\t' read -r filename signed_url; do
  curl -sS -X PUT --data-binary @"$filename" "$signed_url" &
done < manifest.tsv
wait
```

A 200 OK from R2 means the image is now live at `cdn_url`.

### 4. Patch metadata (alt text, etc.)

You set `alt_text` at create time, but if you generate the image first
and only THEN realize what to caption it as, patch later:

```
update_media media_id=<id> alt_text="..." filename="hero-services-v2.png"
```

### 4b. Fill missing alt-text on existing media

When a customer has uploaded a bunch of images without alt-text (very
common after a WP migration), don't make it up — use vision:

```
list_media                                 → find items with empty alt_text
suggest_alt_text_context media_id=<id>     → returns { image_url, suggested_prompt,
                                              language, used_on_pages, current_alt_text }
# Pass image_url + the returned suggested_prompt to YOUR OWN vision
# capability (you can fetch the URL and pass bytes to vision).
update_media media_id=<id> alt_text="<what vision returned>"
```

The prompt is tuned for SEO-grade output: short (5-15 words), no "image
of / picture of" filler, written in the site's content language,
decorative images return empty string. Run it sequentially on a
list_media batch and you can fix alt-text gaps across a whole site
without burning your context on prompt design. The platform does NOT
run vision on your behalf — your model does, your usage.

### 5. Embed in a page

`read_page` the target, insert `<img>` in the right spot:

```html
<img src="<cdn_url>"
     alt="<alt_text>"
     style="width: 100%; height: auto; display: block; margin: 2rem 0;" />
```

Then `update_page` with the new HTML. Or, if you're generating a hero
for a brand-new page, include the `<img>` directly in `create_page`'s
`html_content`.

## Pitfalls

- **Always set `alt_text`.** Empty alt is bad for SEO + accessibility.
  Default to a one-sentence description of what's in the image.
- **`<script>` etc. in SVGs.** The page sanitizer drops `<script>`
  inside SVG, so an icon set that includes script-based animations
  won't render correctly. Use static SVG or a JPG/PNG export.
- **CSS background-image references aren't dedup'd.** If you set the
  same image as a CSS background on multiple pages, the alt-text +
  metadata are page-irrelevant. The sanitizer allows
  `background-image: url(...)` in inline styles, but think about
  whether an `<img>` is actually better.
- **Source URL leakage.** If you generated the image from a prompt
  that contains internal info, don't bake that prompt into the
  filename. Use a descriptive but generic filename.

## Format choice

- **PNG** for logos, icons with hard edges, anything with text.
- **JPG** for photos. Smaller file, better for big hero images.
- **WebP** if the target audience runs modern browsers (95%+ in 2026).
- **SVG** for icons + simple illustrations. Vector scales perfectly.
- **PDF** is supported by `create_upload_url` for document downloads;
  link with `<a href>`, not `<img>`.
