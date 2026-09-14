// Media tools (list + signed upload URL + metadata patch).

import { z } from 'zod';
import { ok, withErrorBoundary, type ToolDef, type ToolDeps } from './helpers.js';

interface UploadUrlResponse {
  upload_url: string;
  cdn_url: string;
  key: string;
  media_id: string;
  expires_in: number;
}

interface UrlUploadInput {
  source_url: string;
  filename?: string;
  content_type?: string;
  alt_text?: string;
}

async function uploadFromUrl(args: UrlUploadInput, deps: ToolDeps): Promise<Record<string, unknown>> {
  // The API checks organization storage before fetching or creating anything.
  // File bytes go from the source to the customer's transfer Worker and R2.
  const source = new URL(args.source_url);
  if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password || source.port ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(source.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(source.hostname)) {
    throw new Error('Source URL must use a public HTTP(S) hostname without credentials.');
  }
  return deps.client.post(deps.siteId, 'media/import', args);
}

export const mediaTools: ToolDef[] = [
  {
    name: 'get_import_readiness',
    description: 'Check whether the organization’s own storage is connected and verified before importing content or media. Returns a Publishing settings link when setup is required.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'media/import'))),
  },
  {
    name: 'read_private_media_url',
    description: 'Get a 60-second read URL for a private media original. Use it for authorized image inspection; never store it in page content or generated source. Use the stable media URL or ID in content.',
    inputSchema: { media_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => ok(await client.get(siteId, `media/${encodeURIComponent(args.media_id)}/content`))),
  },
  {
    name: 'list_media',
    description: 'List uploaded media items (CDN URLs, alt text, mime). Newest first, cursor-paginated.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'media', { limit: args.limit, cursor: args.cursor });
      return ok(res);
    }),
  },
  {
    name: 'get_media_preparation',
    description: 'Read background image preparation progress. Originals and prepared draft variants remain private. Requires site access.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.get(siteId, 'media/preparation'))),
  },
  {
    name: 'prepare_media',
    description: 'Queue or retry background image preparation on the organization’s selected build provider. Requires site admin permission; does not publish the site.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => ok(await client.post(siteId, 'media/preparation'))),
  },
  {
    name: 'read_media',
    description: 'Read one media item\'s metadata by id.',
    inputSchema: { media_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, `media/${encodeURIComponent(args.media_id)}`);
      return ok(res);
    }),
  },
  {
    name: 'create_upload_url',
    description:
      'Mint a 5-min signed PUT URL for direct-to-R2 upload. After the upload completes, the CDN url is what you reference in <img src="…">. REQUIRED follow-up: call `finalize_media` after the PUT succeeds — without it the original ships with no Cache-Control (Lighthouse will flag it) and no responsive variants get generated. The response carries `finalize_url` as a reminder. This signed-PUT path is the INTEGRITY-SAFE way to upload bytes from disk or a generated asset — a direct `curl --data-binary @file` sends the bytes straight to R2 without transcribing them through the model, so it can\'t be corrupted the way a large `upload_media_inline` base64 blob can (ESPECIALLY use this, not inline, for SVG/logos). For a public source URL, `upload_media_from_url` is the one-call equivalent; reserve `upload_media_inline` for tiny payloads only.',
    inputSchema: {
      filename: z.string().min(1),
      content_type: z.string().min(1).describe('e.g. "image/png", "image/jpeg", "application/pdf"'),
      size: z.number().int().nonnegative().optional(),
      alt_text: z.string().optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(siteId, 'media/upload-url', args);
      return ok(res);
    }),
  },
  {
    name: 'upload_media_from_url',
    description:
      'Fetch an image (or PDF) from any public URL and push it to the site\'s media library in one call. The MCP server downloads the source from verified public HTTP(S) destinations; private addresses and unsafe redirects are refused. Integrity-safe: the bytes are streamed, never transcribed as base64 through the model, so (unlike a large `upload_media_inline` payload) they can\'t be silently corrupted in transit. Returns { media_id, cdn_url, filename }.',
    inputSchema: {
      source_url: z.string().url().describe('Public URL to download the image from.'),
      filename: z.string().optional().describe('Override the filename used on R2. Defaults to the last path segment of source_url.'),
      content_type: z.string().optional().describe('Override the inferred content type (e.g. when source_url has no extension).'),
      alt_text: z.string().optional(),
    },
    handler: withErrorBoundary(async (args, deps) => ok(await uploadFromUrl({
      source_url: String(args.source_url),
      filename: args.filename,
      content_type: args.content_type,
      alt_text: args.alt_text,
    }, deps))),
  },
  {
    name: 'upload_media_batch_from_urls',
    description:
      'Upload 1–50 public images/PDFs (max 25 MiB each) in one MCP call. Uses the same integrity-safe download → signed PUT → finalize pipeline as upload_media_from_url, with four concurrent workers. Returns one result per source URL; individual failures do not abort the batch.',
    inputSchema: {
      items: z.array(z.object({
        source_url: z.string().url(),
        filename: z.string().optional(),
        content_type: z.string().optional(),
        alt_text: z.string().optional(),
      })).min(1).max(50),
    },
    handler: withErrorBoundary(async (args, deps) => {
      const results: Array<Record<string, unknown>> = new Array(args.items.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(4, args.items.length) }, async () => {
        while (cursor < args.items.length) {
          const index = cursor++;
          const item = args.items[index]!;
          try {
            results[index] = { source_url: item.source_url, ok: true, ...(await uploadFromUrl(item, deps)) };
          } catch (error) {
            results[index] = { source_url: item.source_url, ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
      });
      await Promise.all(workers);
      return ok({
        results,
        succeeded: results.filter((result) => result.ok === true).length,
        failed: results.filter((result) => result.ok === false).length,
      });
    }),
  },
  {
    name: 'upload_media_inline',
    description:
      'Upload an image (or PDF) from base64-encoded bytes. ⚠️ Use ONLY for tiny payloads (a few KB). The base64 string crosses the model/tool boundary as text, where a larger blob can be SILENTLY CORRUPTED in transit — a few mutated chars yield a broken-but-valid-looking file that uploads with no error and the right size, and only fails when rendered (this has bitten a ~12KB logo SVG: half the wordmark vanished). For anything non-trivial, and ALWAYS for SVG/logos or assets you generated, prefer create_upload_url + a direct curl --data-binary PUT of the file bytes (bytes never transcribed → verified byte-identical), or upload_media_from_url (bytes fetched from a URL). After uploading any generated asset, VERIFY it (render it, or byte-diff against the source) before referencing it. Returns { media_id, cdn_url, filename }.',
    inputSchema: {
      filename: z.string().min(1),
      content_type: z.string().min(1).describe('e.g. "image/png", "image/jpeg", "application/pdf"'),
      data_base64: z.string().min(1).describe('The file bytes, base64-encoded (without a data: URL prefix).'),
      alt_text: z.string().optional(),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      // Tolerate data: URL prefix in case the agent passed one through.
      const raw = args.data_base64.startsWith('data:')
        ? args.data_base64.slice(args.data_base64.indexOf(',') + 1)
        : args.data_base64;
      const buf = Uint8Array.from(Buffer.from(raw, 'base64'));
      if (buf.byteLength === 0) {
        throw new Error('data_base64 decoded to zero bytes — check the encoding.');
      }

      const mint = await client.post<UploadUrlResponse>(siteId, 'media/upload-url', {
        filename: args.filename,
        content_type: args.content_type,
        size: buf.byteLength,
        alt_text: args.alt_text,
      });
      const putRes = await fetch(mint.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': args.content_type },
        body: buf,
      });
      if (!putRes.ok) {
        throw new Error(`R2 upload failed: ${putRes.status} ${putRes.statusText}`);
      }
      // Auto-finalize (cache headers + AVIF/WebP variants). See
      // upload_media_from_url for the same pattern + rationale.
      let finalizeResult: unknown = null;
      let finalizeError: string | null = null;
      try {
        finalizeResult = await client.post(
          siteId,
          `media/${encodeURIComponent(mint.media_id)}/finalize`,
        );
      } catch (e) {
        finalizeError = e instanceof Error ? e.message : String(e);
      }
      return ok({
        media_id: mint.media_id,
        cdn_url: mint.cdn_url,
        filename: args.filename,
        content_type: args.content_type,
        size_bytes: buf.byteLength,
        finalize: finalizeResult,
        finalize_error: finalizeError,
      });
    }),
  },
  {
    name: 'update_media',
    description: 'Patch a media item\'s alt text, filename or public path. A public path change is applied at the next publication.',
    inputSchema: {
      media_id: z.string(),
      alt_text: z.string().optional(),
      filename: z.string().optional(),
      public_path: z.string().nullable().optional().describe('Optional stable path such as /wp-content/uploads/2023/photo.jpg. Applied at the next build; existing public image URLs stay available.'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { media_id, ...body } = args;
      const res = await client.patch(siteId, `media/${encodeURIComponent(media_id)}`, body);
      return ok(res);
    }),
  },
  {
    name: 'generate_image_variants',
    description:
      'Run the build-time srcset pipeline for one image: produces webp + avif variants at 320 / 640 / 1024 / 1920 (skipping upscales), uploads them to R2 alongside the original, and patches the media doc with a variants[] array. Synchronous; takes ~1-5s per image. Skips PDFs and non-image media without erroring. NOTE: prefer `finalize_media` for new uploads — it does this PLUS sets immutable Cache-Control on the original. Use this tool only for surgical variant reruns.',
    inputSchema: { media_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `media/${encodeURIComponent(args.media_id)}/generate-variants`,
      );
      return ok(res);
    }),
  },
  {
    name: 'finalize_media',
    description:
      'Post-upload finalize for a single image: (1) applies immutable Cache-Control (public, max-age=31536000) to the R2 original via in-place CopyObject so the CDN caches it for a year, and (2) generates AVIF/WebP responsive variants if not already present. Call this immediately after a successful upload (the presigned PUT does NOT set cache headers — without finalize, Cloudflare defaults to ~4h and every visit re-fetches the original). Idempotent: safe to call twice. Skips variant work when variants already exist on the doc. INTEGRITY: the result always includes the stored original\'s sha256 + size_bytes — compare against your source file to catch transit corruption before referencing the asset. Better: pass expected_sha256 (hash the file yourself first, e.g. `shasum -a 256 file`) and the server rejects a mismatch with a 422 so corrupted bytes never get blessed with immutable cache headers. Truncated SVGs are rejected outright.',
    inputSchema: {
      media_id: z.string(),
      expected_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional()
        .describe('sha256 (hex) of the SOURCE file. Mismatch with the stored bytes → 422 (re-upload via create_upload_url + direct PUT).'),
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post(
        siteId,
        `media/${encodeURIComponent(args.media_id)}/finalize`,
        args.expected_sha256 ? { expected_sha256: args.expected_sha256 } : {},
      );
      return ok(res);
    }),
  },
  {
    name: 'finalize_all_media',
    description:
      'Backfill version of finalize_media: walks the entire media library, applies cache headers + variant generation to every item missing them. Use this once on legacy sites to fix Lighthouse "cache lifetimes" + "image delivery" warnings in one go. Synchronous, can take minutes on large libraries (~1-5s per image needing variants, ~50ms for cache-only). Idempotent.',
    inputSchema: {},
    handler: withErrorBoundary(async (_args, { client, siteId }) => {
      const res = await client.post(siteId, 'media/finalize-all');
      return ok(res);
    }),
  },
  {
    name: 'suggest_alt_text_context',
    description:
      'Get everything you need to generate good alt-text for a media item: the image URL, a tuned SEO/accessibility prompt, the site\'s content language, and the list of pages where the image is used (with the nearest heading per use site). YOU run the actual vision call with your own model — this endpoint does NOT generate text. After you decide on alt-text, save it with update_media.',
    inputSchema: { media_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(
        siteId,
        `media/${encodeURIComponent(args.media_id)}/alt-text-context`,
      );
      return ok(res);
    }),
  },
  {
    name: 'delete_media',
    description: 'Delete a media item\'s metadata. (R2 object cleanup is a separate ops task.)',
    inputSchema: { media_id: z.string() },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(siteId, `media/${encodeURIComponent(args.media_id)}`);
      return ok(res);
    }),
  },
];
