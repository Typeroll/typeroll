// Pages tools. Read + write + batch + blocks-view + preview.

import { z } from 'zod';
import { ok, withErrorBoundary, versionParam, type ToolDef } from './helpers.js';

function v(version?: string): Record<string, string | undefined> | undefined {
  return version ? { version } : undefined;
}

export const pageTools: ToolDef[] = [
  {
    name: 'list_pages',
    description:
      'List pages on the active site. Returns id, title, slug, status, and SEO summary (no html_content by default — use read_page or batch_read_pages for body content). Supports filtering by status and forward-cursor pagination. Pass full=true to include html_content + blocks in the response.',
    inputSchema: {
      status: z.enum(['draft', 'review', 'unlisted', 'published', 'all']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      full: z.boolean().optional().describe('Set true to include html_content + blocks. Default false (summary only) to avoid large payloads on sites with many pages.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, 'pages', {
        status: args.status,
        limit: args.limit,
        cursor: args.cursor,
        full: args.full ? 'true' : undefined,
        ...v(args.version),
      });
      return ok(res);
    }),
  },
  {
    name: 'read_page',
    description: 'Fetch one page in full — title, slug, status, html_content, SEO fields. Returns the DRAFT VIEW: the saved page with any unsaved draft (working copy) overlaid, plus has_unsaved_changes.',
    inputSchema: {
      page_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.get(siteId, `pages/${encodeURIComponent(args.page_id)}`, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'batch_read_pages',
    description:
      'Read up to 200 pages in a single call. Returns pages_by_id — a map keyed by page_id for easy lookup — plus a not_found list. Use to bulk-load context before a redesign sweep.',
    inputSchema: {
      page_ids: z.array(z.string()).min(1).max(200),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.post<{ pages: { page_id: string; found: boolean; page?: Record<string, unknown> }[] }>(
        siteId,
        'pages/batch-read',
        { page_ids: args.page_ids },
        v(args.version),
      );
      // Transform array → map keyed by page_id for ergonomic access.
      const pages_by_id: Record<string, unknown> = {};
      const not_found: string[] = [];
      for (const entry of res.pages ?? []) {
        if (entry.found && entry.page) pages_by_id[entry.page_id] = entry.page;
        else not_found.push(entry.page_id);
      }
      return ok({ pages_by_id, not_found });
    }),
  },
  {
    name: 'create_page',
    description:
      'Create a new page. Defaults to blocks mode (same as the portal UI\'s "New page" button) ' +
      'and seeds the tree with a heading + prose block so the editor is never blank. ' +
      'Pass html_content (or content_mode="html") to opt into raw-HTML mode instead. ' +
      'Slug is derived from the title when omitted. Default status is "draft". ' +
      'Homepage convention: pass slug="" (empty string) or omit slug and set title to "Home"; ' +
      'the server stores it under id "home" with slug "". ' +
      'Slug must be a single path segment (no slashes). For nested URLs like ' +
      '/erbjudanden/sommar or /tjanster/design, set the optional `path` field explicitly — ' +
      'e.g. path="/erbjudanden/sommar". For many similar items use a collection with route_template ' +
      '(see tr-blog / tr-directory), but for a small group of bespoke pages sharing a URL prefix, ' +
      '`path` is the right primitive. ' +
      'Returns the created page (blocks for blocks-mode, html_content for html-mode) including ' +
      '`url` (the resolved live URL).',
    inputSchema: {
      title: z.string().min(1),
      slug: z.string().optional().describe('URL slug — single path segment, no slashes (e.g. "about", "kontakt"). Empty string "" = homepage. For nested URLs set the `path` field explicitly — `slug` stays a leaf id.'),
      path: z.string().optional().describe('Optional explicit URL path for nested pages (e.g. "/erbjudanden/sommar-2026"). When set, takes precedence over slug for routing. Must start with "/", lowercase a-z/0-9/-/_/ only, no "..", no "//", no trailing slash. Slug is still required as the leaf id but two pages CAN share a slug under different paths.'),
      content_mode: z.enum(['blocks', 'html']).optional().describe('Default "blocks". "blocks" stores a Block[] tree (the modern default — supports the full ~40-block library, page templates, and the responsive system). "html" stores raw markup in html_content (legacy path, still fully supported for imported content or hand-written HTML). Passing html_content without content_mode also opts into "html".'),
      html_content: z.string().optional().describe('Body HTML — only used when content_mode="html".'),
      blocks: z.array(z.any()).optional().describe('Block tree — only used when content_mode="blocks". Omit to get the default heading+prose seed.'),
      status: z.enum(['draft', 'review', 'unlisted', 'published']).optional(),
      seo_title: z.string().optional(),
      append_seo_suffix: z.boolean().optional().describe('Set false to omit the site default SEO suffix on this page.'),
      seo_description: z.string().optional(),
      seo_image_alt: z.string().optional(),
      alternates: z
        .array(z.object({ hreflang: z.string(), href: z.string() }))
        .optional()
        .describe('Cross-domain hreflang cluster: the equivalents of THIS page on sister language sites, as [{ hreflang, href }]. One Typeroll site owns one domain, so a multi-language family (example.se / example.de / example.co.uk) is several sites and the mapping can\'t be derived — declare it here. List only the OTHER variants; the renderer injects this page\'s self-reference automatically. hreflang is a BCP-47 tag ("sv", "en-GB") or "x-default"; href must be an absolute http(s) URL. Invalid entries are rejected at write time with the reason, so a half-written cluster never ships. Every page in a cluster must link every other one — write all sides.'),
      schema_type: z.string().optional().describe('Free-form Schema.org type ("Service", "Course", "Product", …) for auto JSON-LD.'),
      kind: z.enum(['page', 'article']).optional(),
      author: z.string().optional(),
      language: z.string().optional().describe('BCP-47 tag overriding the site default (e.g. "en" on an otherwise Swedish site).'),
      template: z.string().optional().describe('Page template id (PageTemplate). Wraps the body in the template tree at render time.'),
      image_sizes_default: z.string().optional().describe('Per-page default `sizes` for responsive images (e.g. "(max-width: 640px) 360px, 560px"). Overrides the site setting; a per-<img> `sizes` attr still wins. Set when this page\'s images render narrower than the generic default so the browser stops over-fetching.'),
      custom_css: z.string().optional().describe('Per-page CSS, injected into <head> as a <style> AFTER the site-level custom_css (so it overrides site styling). This is the RIGHT home for page-specific styling — page metadata, not content. Put a page\'s <style> here instead of stuffing it into a core/html block (which is opaque and un-editable in the visual editor).'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const { version, ...body } = args;
      const res = await client.post(siteId, 'pages', body, v(version));
      return ok(res);
    }),
  },
  {
    name: 'update_page',
    description:
      'Shallow-merge update on a page (only the fields you pass change). BUFFER MODEL: content fields land in the page\'s unsaved DRAFT (working copy) — invisible to deploys and default previews until saved; `status`/`date_published` apply immediately. Pass save:true to commit in the same call, or commit_working_copy later after the user approves. Returns the draft view of the page. For "replace this page entirely", use replace_page. To switch content_mode safely, prefer `set_page_mode`.',
    inputSchema: {
      page_id: z.string(),
      patch: z
        .object({
          title: z.string().optional(),
          slug: z.string().optional(),
          content_mode: z.enum(['blocks', 'html']).optional().describe('Changing this raw skips revision snapshotting — for safe switches use set_page_mode.'),
          html_content: z.string().optional(),
          blocks: z.array(z.any()).optional().describe('Block tree, only used when content_mode="blocks".'),
          status: z.enum(['draft', 'review', 'unlisted', 'published']).optional(),
          publish_at: z.string().nullable().optional().describe(
            'Scheduled publishing (0.29.0+): ISO datetime at which the platform flips status → published AND deploys the site. Applies immediately (publish state, never drafted); null clears the schedule. Requires the SAVED content to be ready — schedule after save_changes/commit.',
          ),
          unpublish_at: z.string().nullable().optional().describe(
            'Scheduled unpublish: ISO datetime at which status flips back to draft (+ deploy). Null clears.',
          ),
          kind: z.enum(['page', 'article']).optional(),
          author: z.string().optional(),
          language: z.string().optional(),
          seo_title: z.string().optional(),
          append_seo_suffix: z.boolean().optional().describe('Set false to use seo_title/page title verbatim without the site suffix.'),
          seo_description: z.string().optional(),
          og_image: z.string().optional(),
          seo_image_alt: z.string().optional().describe('Alt text for og:image/twitter:image. Falls back to first <img alt> on the page when unset.'),
          canonical_url: z.string().optional(),
          path: z.string().optional().describe('Explicit URL path for nested pages (e.g. "/erbjudanden/sommar-2026"). Takes precedence over slug for routing; changing it auto-creates a 301 from the old URL on save.'),
          noindex: z.boolean().optional(),
          alternates: z
            .array(z.object({ hreflang: z.string(), href: z.string() }))
            .nullable()
            .optional()
            .describe('Cross-domain hreflang cluster: the equivalents of THIS page on sister language sites, as [{ hreflang, href }]. One Typeroll site owns one domain, so a multi-language family (example.se / example.de / example.co.uk) is several sites and the mapping can\'t be derived — declare it here. List only the OTHER variants; the renderer injects this page\'s self-reference automatically. hreflang is a BCP-47 tag ("sv", "en-GB") or "x-default"; href must be an absolute http(s) URL. Invalid entries are rejected at write time with the reason, so a half-written cluster never ships. Every page in a cluster must link every other one — write all sides. Pass null to clear the cluster.'),
          lastmod_override: z.string().optional().describe('Override the sitemap <lastmod>. Empty string suppresses lastmod for this page entirely.'),
          image_sizes_default: z.string().optional().describe('Per-page default `sizes` for responsive images (e.g. "(max-width: 640px) 360px, 560px"). Overrides the site setting; a per-<img> `sizes` attr still wins. Set when this page\'s images render narrower than the generic default so the browser stops over-fetching the larger variant.'),
          custom_css: z.string().optional().describe('Per-page CSS, injected into <head> as a <style> AFTER the site-level custom_css (so it overrides site styling). The RIGHT home for page-specific styling — put a page\'s <style> here instead of stuffing it into a core/html block.'),
          json_ld: z.string().optional(),
          schema_type: z.string().optional().describe('Free-form Schema.org type ("Service", "Course", "Product", …) used for auto JSON-LD emission. Use service.* for Service-specific fields.'),
          service: z
            .object({
              price: z.union([z.number(), z.string()]).optional(),
              price_currency: z.string().optional().describe('ISO 4217 (SEK, EUR, USD).'),
              duration: z.string().optional(),
              description: z.string().optional(),
              url: z.string().optional(),
            })
            .optional(),
          template: z.string().optional(),
        })
        .passthrough(),
      save: z.boolean().optional().describe(
        'Also SAVE (commit) the draft in the same call — use for pre-approved or batch changes. Without it, changes stay in the unsaved draft until commit_working_copy.',
      ),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.patch(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}`,
        { ...args.patch, ...(args.save ? { save: true } : {}) },
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'replace_page',
    description:
      'Full replace of a page\'s writable content fields (PUT) — omitted fields are cleared. BUFFER MODEL: the replacement is an unsaved DRAFT until committed; pass save:true to commit in the same call. Use update_page for shallow merge.',
    inputSchema: {
      page_id: z.string(),
      page: z.object({ title: z.string().min(1) }).passthrough(),
      save: z.boolean().optional().describe(
        'Also SAVE (commit) the draft in the same call — use for pre-approved or batch changes. Without it, changes stay in the unsaved draft until commit_working_copy.',
      ),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.put(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}`,
        { ...args.page, ...(args.save ? { save: true } : {}) },
        v(args.version),
      );
      return ok(res);
    }),
  },
  {
    name: 'batch_update_pages',
    description:
      'Apply per-page patches in one call (up to 200 entries). Each entry is { page_id, patch, save? }; failures are reported per-row, the rest still apply. BUFFER MODEL: content patches land in each page\'s unsaved draft; per-entry save:true (or the top-level save flag) commits — typical for a user-approved sweep.',
    inputSchema: {
      updates: z
        .array(
          z.object({
            page_id: z.string(),
            patch: z.record(z.unknown()),
            save: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(200),
      save: z.boolean().optional().describe('Commit every entry\'s draft (shorthand for save:true on each).'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const updates = args.save
        ? args.updates.map((u: { page_id: string; patch: Record<string, unknown>; save?: boolean }) => ({ ...u, save: true }))
        : args.updates;
      const res = await client.post(siteId, 'pages/batch-write', updates, v(args.version));
      return ok(res);
    }),
  },
  {
    name: 'clone_page',
    description:
      'Duplicate an existing page under a new title + slug. Use this when you want a near-copy of an existing page as the starting point (e.g. duplicate "Privatflytt" → "Privatflytt Härnösand"). The new page is created as a draft regardless of the source\'s status. Returns the created page.',
    inputSchema: {
      source_page_id: z.string(),
      title: z.string().min(1).describe('Title for the new page.'),
      slug: z.string().optional().describe('Slug for the new page. Omit to auto-derive from title.'),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      // 1. Read the source — full body + SEO fields.
      const sourceRes = await client.get<{ page: Record<string, unknown> }>(
        siteId,
        `pages/${encodeURIComponent(args.source_page_id)}`,
        v(args.version),
      );
      const src = sourceRes.page;
      // 2. Build the new page body. Title + slug from args, everything else
      //    copied — except the new page always starts as a draft so cloning
      //    a published page doesn't accidentally publish a half-edited copy.
      // Critical: preserve the source's content_mode exactly. Without
      // this, create_page falls back to its blocks-default and seeds a
      // fresh heading+prose tree, leaving the clone with TWO content
      // sources (the copied html_content AND a default blocks[]). Bug
      // surfaced in MCP-FEEDBACK-2.md from the Sundsvallsflytt demo build.
      const srcMode = (src.content_mode as 'blocks' | 'html' | undefined) ?? 'html';
      const body: Record<string, unknown> = {
        title: args.title,
        content_mode: srcMode,
        html_content: srcMode === 'html' ? src.html_content : '',
        blocks: srcMode === 'blocks' ? (src.blocks ?? []) : undefined,
        seo_title: src.seo_title,
        append_seo_suffix: src.append_seo_suffix,
        seo_description: src.seo_description,
        og_image: src.og_image,
        canonical_url: undefined,  // intentionally NOT copied — point of canonical is to differ
        noindex: src.noindex,
        kind: src.kind,
        author: src.author,
        json_ld: undefined,  // structured data is usually page-specific; force re-author
        template: src.template,
        status: 'draft',
      };
      if (args.slug) body.slug = args.slug;
      // 3. Create. The server auto-uniques the slug if it clashes.
      const created = await client.post(siteId, 'pages', body, v(args.version));
      return ok(created);
    }),
  },
  {
    name: 'delete_page',
    description: 'Delete a page (tombstoned on branches, removed on main).',
    inputSchema: {
      page_id: z.string(),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const res = await client.del(siteId, `pages/${encodeURIComponent(args.page_id)}`, v(args.version));
      return ok(res);
    }),
  },
  // get_page_blocks lives in tools/page-blocks.ts alongside the rest of
  // the block-tree mutation tools (add/update/move/remove/convert).
  {
    name: 'get_page_preview',
    description:
      "Get the WHOLE page rendered as one self-contained HTML document — header partial + block-rendered body + footer partial, with the site's settings CSS variables, global styles, and the tree-shaken block-CSS bundle all inlined, exactly as deployed. This is the single artifact for UNDERSTANDING what a page looks like and how its CSS actually cascades (get_page_blocks gives the editable block tree; this gives the rendered result). Returns { rendered_html, internal_links[] }. Pass annotate:true to tag every element with data-block-id + data-block-type so you can map the rendered HTML back to the block to edit. For a clickable preview URL use get_preview_link instead.",
    inputSchema: {
      page_id: z.string(),
      annotate: z
        .boolean()
        .optional()
        .describe(
          'Tag every block root with data-block-id (the authored block id) + data-block-type so you can map a rendered element back to the exact block to mutate. Off by default.',
        ),
      include_working_copy: z
        .boolean()
        .optional()
        .describe(
          'Overlay unsaved drafts (working copies) on the render — yours and the editor\'s. Off by default (saved content only). Pass true to inspect your own uncommitted edits.',
        ),
      version: versionParam,
    },
    handler: withErrorBoundary(async (args, { client, siteId }) => {
      const query: Record<string, string | undefined> = { ...(v(args.version) ?? {}) };
      if (args.annotate) query.annotate = 'true';
      if (args.include_working_copy) query.working_copy = 'true';
      const res = await client.get(
        siteId,
        `pages/${encodeURIComponent(args.page_id)}/preview`,
        query,
      );
      return ok(res);
    }),
  },
];
