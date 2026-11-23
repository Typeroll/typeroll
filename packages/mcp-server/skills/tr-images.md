---
name: tr-images
description: Use when the user asks for an image, hero, illustration, or logo to be created and embedded in a Typeroll page. Covers the two-step signed-URL upload flow so the agent doesn't try to POST bytes through the CMS API (it can't).
---

# Add images to a Typeroll site

The Typeroll API does NOT accept image bytes directly. Uploads go
through a signed PUT URL straight to Cloudflare R2, and the API only
sees the metadata. For local files, mint an upload URL, PUT the bytes, then
finalize and verify the result before referencing it:

For public source URLs, prefer `upload_media_from_url`; for 2–50 files use
`upload_media_batch_from_urls` (max 25 MiB per file). Both download, upload,
and finalize each asset automatically. Batch results preserve input order and
report failures per item, so retry only the failed entries. Use the manual
signed-URL flow below for local files or when you need direct control over the
PUT.

## Recipe

### Public address continuity

Do not create a redirect for every uploaded image or generated variant. Update
all current HTML, `srcset`, CSS and share-image references to the verified new
address. Preserve old public file URLs for external embeds, image search and
shared links: keep safe aliases where possible, use an established prefix
mapping when the complete remaining path is unchanged, and retain exact rules
for exceptions such as unrelated content hashes. A `public_path` preserves a
path, not a hostname. Never invent a wildcard from a partial import inventory.
Private editor addresses and never-public variants need no automatic redirects.
Do not delete configured redirects merely because current HTML no longer uses
them. Core 0.3.48 compacts equivalent per-file rules in the frozen publication;
stored rules stay intact. See https://typeroll.com/docs/tools/redirects/.

From Core 0.3.49, new uploads default to the media root (`photo.jpg`), without
automatic year/month folders. Explicit folders and WordPress upload-relative
folders are preserved; `wp-content/uploads` and multisite prefixes are removed
from new addresses. Different bytes receive permanent numeric names (`photo-2.jpg`);
safe old aliases for included media stay available without a redirect per replacement.
Managed WordPress imports declare their uploads namespace so publication can
use one prefix with exact collision exceptions. A borrowed image alone does
not declare a namespace. Check the returned public paths and the complete old
URL inventory; Cloud requires the corresponding platform release. A reserved name
does not retain a deleted or unused file in every future build. Private object
keys and responsive variants can still contain hashes; never construct URLs
from those internal keys.

### 1. Get an image

Options, in order of preference:

a. **Reuse an existing one.** Search `list_media` before generating anything.
   From Core 0.3.48 it also lists pending or failed imports for repair: select
   only records whose `readiness.selectable` is true. A reserved CDN address
   alone does not establish that a usable file exists.

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
  "cdn_url": "https://portal.example.com/api/sites/site/media/abc123/content",
  "key": "private/media/<site-prefix>/uploads/<upload-id>/hero-services.png",
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
curl --fail-with-body -sS -X PUT -H "Content-Type: image/png" \
  --data-binary @hero-services.png "$UPLOAD_URL"
```

Send the same `Content-Type` used to request the upload URL. Do not attach your
Typeroll API key or copy the URL's signing query parameters into headers.

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

For many local files, use bounded concurrency and record each PUT result
against its media ID. Send each file's declared Content-Type, finalize only
successful uploads, and inspect every finalization result before creating
references. A background shell loop's final exit code does not prove that
all its uploads succeeded. Retry failed entries, not the entire batch.

A successful PUT means the upload reached storage; it is not yet a verified
or public image. Call `finalize_media media_id=<id> expected_sha256=<source-hash>`
(or the returned finalization endpoint) and inspect the result before referencing it.
Finalization freezes the private original and queues background image
preparation. It does not publish the file. Use the returned authenticated
`cdn_url` in content only after verification; website publication rewrites it
to the public address. A PDF can be published separately with
`publish_media_file`. A 202/pending import is not a completed upload.

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

## Check publication resolution (Core 0.2.37+)

Native AVIF/WebP generation includes each smaller preset and the full original
width, without upscaling or duplicate width descriptors. Check `currentSrc` and
the actual encoded dimensions on the published site; the CMS preview can use the
original and hide an undersized derivative. Do not compensate with custom CSS
or `sizes` alone. Existing static sites need republication for the versioned v2
recipe; unchanged subsequent builds reuse verified media.
`generate_image_variants` reports pending build-time work; it does not encode
variants synchronously or repair a broken upload. Inspect `get_media_preparation`
and the actual published output instead of looping that endpoint.

## Replace an existing image efficiently

For one Page, use `update_page` with only the changed `fields` and `save:true`
after approval; do not echo an unchanged block tree. For many Pages use
`batch_update_pages` in batches of 20–50, one entry per Page. Inspect every result
and retry only failed entries. Review any earlier unsaved draft before saving.

When the same library file should change everywhere, prefer `replace_media`:
upload the new file, run `dry_run:true`, review the site-wide/all-version scope,
then apply `dry_run:false`. It changes the library relationship without saving
each Page. Page-specific alt text and crop settings remain unchanged; review them.
Preview before normal publication. Do not delete either original as part of the
replacement. Clearing `replacement_media_id` restores the original for future
previews/publications; existing live output changes only after publication.
