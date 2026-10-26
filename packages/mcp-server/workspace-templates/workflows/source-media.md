# Preserve source media before retirement

This is a separate owner-approved archive, not an import of every old file into
the CMS. Do not delete source files or cancel old hosting as part of this routine.

1. Inventory originals and downloads from the source API/export, including files
   absent from published pages. Include drafts, private records and historical
   attachments when authorized. A public sitemap or REST response cannot prove
   the library is complete. Keep the export under ignored `sources/private/`.
2. Compare with the new site's references, including templates, partials and
   retained URLs. Record used, unused and uncertain files. "Unused" is not an
   instruction to delete. Preserve print originals even when a web derivative exists.
3. Agree a private archive destination, its owning account, retention and access.
   Verify account/bucket identity and that public bucket/custom-domain access is
   disabled. Use the owner's credentials through their secret manager; never put
   credentials in scripts or manifests. Do not provision or expose a bucket silently.
4. Copy with bounded concurrency and bounded reads, stream large files and use
   resumable transfers when supported. Preserve a collision-safe key derived from
   the full source host/path, not just the filename. Never overwrite a different
   object merely because the basename matches.
5. Record source URL, destination key, source ID, byte count, SHA-256, media type,
   title/alt/caption, copy time and verification state in a private manifest.
   ETag is not universally MD5 (multipart objects and providers differ). Use a
   documented checksum API or stream the destination back and compare SHA-256
   and size. Metadata claiming a hash is not proof of the uploaded bytes.
6. Resume only verified matches; report every unavailable source and hash conflict.
   Verify a restore from the archive, including a large file. Keep an independent
   private copy of the manifest. The owner reviews completeness and grants a
   separate old-host retirement decision. This archive does not preserve old
   public URLs by itself: keep URL parity/redirect acceptance separate.

## Prepare print images for the web

Use `scripts/typeroll/prepare_image.py` for a reviewed local TIFF or other original.
Install Pillow with ImageCms in an isolated environment. It applies EXIF
orientation, converts through the embedded (or explicitly supplied) ICC profile
to sRGB, embeds the sRGB profile, strips source EXIF metadata and writes a new
JPEG. It never changes the original, uploads files or edits a Page.

```sh
python3 scripts/typeroll/prepare_image.py sources/private/original.tif sources/private/web.jpg
```

CMYK without the correct profile fails; obtain the actual source profile instead
of guessing. `--source-profile sources/private/original.icc` supplies it.
Unprofiled RGB/gray requires an explicit `--assume-srgb` decision. Multi-page,
animated and transparent images require a separate reviewed workflow. Compare
colour, subject framing and sharpness visually before upload. Upload through the
normal integrity-checked media flow and choose alt/caption text independently.
Store the tool's hash report privately; never commit customer images or archives.
