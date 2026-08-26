---
name: tr-migrate-astro
description: Use when the user wants to migrate an Astro site — particularly an Astro Content Collections-backed site — to Typeroll. Walks `src/content/<collection>/*.md(x)`, lifts frontmatter into Typeroll collection schemas, converts markdown bodies into richtext fields, batch-imports items, then maps `src/pages/*` into Typeroll pages/partials. Triggers on "migrate an Astro site", "import from src/content", "convert content collections", or when the user names a local Astro repo as the source.
---

# Migrate an Astro site to Typeroll

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


Astro's [Content Collections](https://docs.astro.build/en/guides/content-collections/) and Typeroll's `Collection` + `CollectionItem` map one-to-one. A collection in Astro is a directory of frontmatter-bearing files under `src/content/<name>/`; in Typeroll it's a schema + items doc set under `organizations/{org}/sites/{site}/collections/{name}/`. The Astro schema (`zod.object(...)` in `src/content/config.ts`) is your field list. The frontmatter values are field values. The markdown bodies are richtext fields.

This skill walks the migration from a checked-out Astro repo on the user's machine to a target Typeroll site. You run it locally — the source repo is on disk, the MCP just receives the final shape.

## Preconditions

- The Astro repo is checked out locally and `npm install`d (so we can read `src/content/config.ts` to extract the schemas).
- `@typeroll/mcp-server` configured with a valid `TYPEROLL_API_KEY` pointing at the target site (or org-scoped key + a `site_id` argument per call).
- Target Typeroll site exists. **Empty starter site is best.** If non-empty, treat existing pages and collections as off-limits unless the user explicitly says otherwise.
- The Astro design / theme is **not** being migrated — Typeroll has its own design layer. We migrate content; the user re-skins on the Typeroll side.

## Recipe

### 1. Map the source

From the Astro repo root:

```bash
ls src/content/                  # which collections exist?
cat src/content/config.ts        # collection schemas (zod)
ls src/pages/                    # standalone pages
ls public/                       # static assets and images
```

Build a working manifest:

| Astro source | Typeroll target |
|---|---|
| `src/content/blog/*.md` | Collection `blog` with items |
| `src/content/projects/*.mdx` | Collection `projects` with items |
| `src/pages/about.astro` | Page with slug `about` |
| `src/pages/services/[slug].astro` | If dynamic from a collection → that collection's `route_template`. If genuinely per-page → individual Typeroll pages. |
| `public/og/*.png`, `public/images/*` | Upload to Typeroll media via `upload_media_from_url` (after staging them on a temporary public URL) or via local upload if the MCP supports it. |
| `src/layouts/*.astro` | Header / footer / shared chunks → Typeroll partials. The rest of the layout is the site design, owned by the target site. |
| `src/components/*.astro` | Either become partials (if reused across pages) or get inlined into the page that uses them. |

### 2. Learn the target's design (don't skip)

```
get_site
read_site_settings           # colours, fonts, voice
list_partials
read_partial partial_id="header"
list_pages limit=5
```

Same rule as in `tr-migrate-wp`: you're moving content into the *target's* visual language, not preserving the source's. Note the existing fonts, colour vars, header structure.

### 3. Translate one collection schema

Pick the most representative collection first (usually `blog`). Read its zod schema:

```ts
// src/content/config.ts
const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    heroImage: z.string().optional(),
    author: z.string().default('Editorial'),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});
```

Map zod types to Typeroll field types:

| Astro zod | Typeroll field type |
|---|---|
| `z.string()` | `text` (or `textarea` if it's a description/excerpt — judge by typical length) |
| `z.string().long()` / a description field | `textarea` |
| `z.coerce.date()` / `z.date()` | `date` |
| `z.number()` | `number` |
| `z.boolean()` | `boolean` |
| `z.string()` with image path / `image()` helper | `image` |
| `z.array(z.string())` | `text` (comma-joined) or `tags` if you have a tags field type |
| `z.enum([...])` | `text` with a comment about the allowed values; the model writes the listing logic |
| `z.object({...})` (nested) | Flatten into prefixed fields, or pre-render into a `*_html` field (see `tr-collection-template`) |
| Markdown body | `body: richtext` (the markdown content of the file, converted to HTML — see §4) |

Create the collection with the design template baked in (this is the new pattern — read `tr-blog` if you haven't yet):

```
create_collection {
  "name": "blog",
  "label_singular": "Article",
  "label_plural": "Articles",
  "slug_field": "slug",
  "sort_field": "date",
  "sort_dir": "desc",
  "route_template": "/blog/{slug}",
  "fields": [
    {"name":"title",       "type":"text",     "required":true},
    {"name":"slug",        "type":"text",     "required":true},
    {"name":"description", "type":"textarea"},
    {"name":"date",        "type":"date",     "required":true},
    {"name":"updated_date","type":"date"},
    {"name":"hero_image",  "type":"image"},
    {"name":"author",      "type":"text"},
    {"name":"tags",        "type":"text"},
    {"name":"body",        "type":"richtext"}
  ],
  "item_template_html": "<article class=\"post\">...</article>"
}
```

Field-name rules: ASCII, lowercase, `[a-z][a-z0-9_-]*`. The Astro source `pubDate` → Typeroll `date`. `updatedDate` → `updated_date` (snake_case is fine; camelCase isn't).

### 4. Convert markdown bodies → richtext

Astro stores the markdown body as the file content after the `---` frontmatter fence. Typeroll's `body: richtext` wants HTML. Pick one of:

**Option A — use Astro's own markdown renderer (preferred when the repo already builds):**

```js
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

const md2html = async (md) => {
  const file = await unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(md);
  return String(file);
};
```

Run this on the body of every collection file. Image references inside the markdown (`![alt](./hero.png)`) need their `src` rewritten to the uploaded Typeroll CDN URLs after step 6.

**Option B — convert ad-hoc:** `marked`, `markdown-it`, or any other parser. Just stay consistent across files so the HTML output looks uniform.

Typeroll's sanitiser will strip `<script>` and event handlers from the output regardless. If the markdown carried embedded raw HTML you want to keep (iframes for video, etc.), check the sanitiser config in `packages/site-template/src/lib/sanitize.ts` for the whitelist.

### 5. Resolve and upload images

For every image referenced by an item (`heroImage`, images inside the markdown body):

1. Stage the local file at a temporary public URL (or use a local-upload MCP tool if one is configured).
2. `upload_media_from_url url=<staged-url> alt=<from frontmatter or filename>` — record the returned CDN URL.
3. Substitute the CDN URL into both the `hero_image` field value AND the markdown-converted HTML body (regex replace `src=` references).

Keep a local map (`./astro-migration-state.json`):

```json
{
  "media": {
    "./hero.png": "https://cdn.typeroll.com/<orgId>/<siteId>/abc123.png"
  }
}
```

So a partial run is resumable and you don't re-upload the same image twice.

### 6. Batch-import items

For each file in `src/content/<collection>/`:

```js
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const files = fs.readdirSync('src/content/blog').filter(f => /\.mdx?$/.test(f));
for (const file of files) {
  const raw = fs.readFileSync(`src/content/blog/${file}`, 'utf8');
  const { data, content } = matter(raw);
  const slug = file.replace(/\.mdx?$/, '');
  const body = await md2html(content);

  // create_collection_item via the MCP
  await mcp.callTool('create_collection_item', {
    collection: 'blog',
    status: data.draft ? 'draft' : 'published',
    fields: {
      title:        data.title,
      slug,
      description:  data.description,
      date:         data.pubDate ? new Date(data.pubDate).toISOString().slice(0, 10) : null,
      updated_date: data.updatedDate ? new Date(data.updatedDate).toISOString().slice(0, 10) : null,
      hero_image:   mediaMap[data.heroImage] || data.heroImage,
      author:       data.author,
      tags:         (data.tags || []).join(', '),
      body,
    },
  });
}
```

Rate-limit awareness: spawn at most 5 parallel `create_collection_item` calls; the API caps at ~60 writes/minute and responds with 429 + `Retry-After` if exceeded.

Set `status: 'draft'` (or honour Astro's `draft: true` frontmatter) for items the user should review before publishing. Only published items get static pages.

### 7. Build the listing page

```
create_page title="Blog" slug="blog" status="published" content_mode="html"
  html_content="<section><h1>Blog</h1>
  <!-- typeroll:listing:blog -->
  <!-- /typeroll:listing:blog -->
</section>"

regenerate_collection_listing
  collection="blog"
  page_id="blog"
  item_template="<article class=\"blog-card\"><a href=\"{{url}}\"><h2>{{title}}</h2><p>{{description}}</p><time>{{date}}</time></a></article>"
  wrap_open="<div class=\"blog-grid\">"
  wrap_close="</div>"
```

See `tr-blog` for full styling and post-import update flow.

### 8. Translate standalone pages

For each non-dynamic `.astro` page under `src/pages/`:

```
read_partial partial_id="header"          # learn target's nav style
# Re-skin the page content using target site's CSS variables and partials.
create_page title="About" slug="about" status="draft" content_mode="html"
  html_content="..."
```

Default to **draft** — the user reviews each page before publishing.

For dynamic Astro pages (`[slug].astro` that consume a collection), you're already done: the matching Typeroll collection's `route_template` produces the same URLs at build time.

### 9. Add redirects for URL changes

If Astro's slugs differed from what you derived for Typeroll (e.g. Astro had `/posts/my-article` but you want `/blog/my-article`), bulk-add redirects:

```
add_redirect from="/posts/my-article" to="/blog/my-article" status=301
```

Or build a redirect map from the `astro-migration-state.json` and apply it in one pass.

### 10. Deploy

```
trigger_deploy
get_deploy_status job_id=<id>
```

Browse the resulting site, compare against the Astro source, surface anything that drifted.

## Astro-specific gotchas

- **`.mdx` files with custom components.** Components inside MDX (`<MyCustom prop="..." />`) will not render in Typeroll because the component definitions don't migrate. Two options: (1) replace each component with its rendered HTML output (run the Astro build, scrape the rendered HTML, use that as `body`); (2) if the component is a reusable visual element used across many items, factor it into a Typeroll partial and replace MDX usages with `<x-include name="..." />` calls. See `tr-page-template` for the partial-include pattern.
- **`src/content/config.ts` typed `image()` helper.** Astro resolves `image()` fields at build time to optimised assets. After migration the Typeroll `hero_image` field carries the original source URL — re-upload via step 5 to get it onto the Typeroll CDN.
- **`getCollection` filters at runtime.** If `src/pages/blog/index.astro` does `getCollection('blog', ({ data }) => !data.draft)`, Typeroll handles this via `status` on the item. Don't translate the filter — set `status: 'draft'` on items where `data.draft === true`.
- **Per-tag pages (`/blog/tag/[tag].astro`).** Typeroll doesn't auto-generate these. Either (a) drop tag pages and use a client-side filter in the blog listing JS, (b) generate them by enumerating unique tags and calling `create_page` per tag with a server-side-pre-filtered listing. (a) is preferable for ≤dozens of tags.
- **`rehype-pretty-code` / shiki / fenced code with syntax highlighting.** The HTML output of these contains inline styles that the Typeroll sanitiser preserves. The colours match the Astro site's theme at import time; redoing the target design later means re-running the highlighter against the same markdown source. Keep a copy of the raw markdown if you might.
- **`og:image` per page from `astro-og-image` style plugins.** Typeroll has its own SEO surface (`seo_title`, `seo_description`, `seo_og_image`). Set them explicitly on each page during step 8.
- **i18n via `src/content/<lang>/<collection>/`.** Typeroll's site-level `default_language` + per-page `language` field cover this (capabilities: `supports_language_per_page: true`). Map each language directory to per-item `language: 'sv-SE' | 'en-US' | …` instead of separate collections.

## Mixing imported + new content

Half-migrate, leave drafts, let the user inspect, iterate. You can:

- Import only collections, skip standalone pages, let the user rebuild those from scratch.
- Import everything as `status: 'draft'`, treat publishing as a per-item human review pass.
- Mix sources: pull article bodies from Astro markdown, use Claude to generate fresh excerpts/SEO metadata before writing the item.

Keep the local `astro-migration-state.json` honest — it's the only way to make a partial run resumable when the API rate-limits or a markdown parser trips on an edge case file.
