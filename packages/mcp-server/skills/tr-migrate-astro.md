---
name: tr-migrate-astro
description: Migrate an existing Astro site, including Astro Content Collections, to native Typeroll Pages and Content types while preserving routes, design and media.
---

# Migrate an Astro site

Astro Content Collections are source data. In Typeroll, each source record
becomes a Page, and each source schema becomes a Content type. Static Astro
pages use that same Page model. Shared Astro layouts become Page templates,
partials or reusable block types; no separate item storage is created.

## Inventory before writing

Read the source repository's routing, content loaders, schema, frontmatter,
layouts, components, styling and public assets. New Astro projects can define
loaders in `src/content.config.ts`; older projects may use
`src/content/config.ts` and files under `src/content/`. Follow what the actual
project uses, including generated route logic and trailing-slash policy.

Discover the target with `get_site`, `get_site_capabilities`, `list_pages`,
`list_content_types`, `list_page_templates` and `list_block_types`. Existing target
content remains out of scope unless the user authorized replacing it. Create a
site version for the migration and pass it consistently on all versioned calls.
Call `get_migration_readiness` before import; connect verified customer storage
before transferring any source content or media.

Record a URL inventory from the existing site and source routing. Use explicit
Page paths to preserve nested routes or frontmatter-based permalinks. Do not
assume that a filename alone determines the production URL.

## Map the source

- Common frontmatter such as title, slug, author, publication date and SEO maps
  to top-level Page metadata.
- Other schema fields become the Content type's custom fields and Page `fields`.
  Preserve typed objects and arrays; use `page_ref`/`page_ref_list` for relations.
- Markdown becomes native Page body blocks. First render Markdown to HTML using
  the source project's parser, then review block conversion. MDX components
  require explicit equivalents; never drop them as if they were plain Markdown.
- A shared layout becomes a reusable Page template with `template_content_slot`.
  Assign it as the type's default. Header/footer and reusable fragments can be
  partials. Use native blocks before choosing a rare reviewed HTML/embed exception.
- Browser scripts, integrations and server-rendered endpoints need separate
  review. A static Page cannot inherit a private server runtime by copying its
  source text. Configure the supported Forms/Extension runtime explicitly.

Create templates with `create_page_template`, types with `create_content_type`,
then one `create_page` per source record. Use returned Page IDs, not source IDs
or slugs, for later updates and previews. For linked content, create the Pages
first and resolve their reference fields in a second pass.

Upload assets to connected storage and rewrite source-relative image references
to returned media URLs. Use direct upload URLs for local bytes and the customer
transfer flow for remote media; do not relay large base64 payloads through the
model. Preserve alt text, captions, dimensions, links and image variants.

## Listing and verification

An archive is a Page with `core/page_list` filtered by `content_type`. Configure
sorting and pagination from the block schema. It reads saved Pages at build
time; do not generate a second listing representation or call a regeneration tool.

Check representative long/short bodies, code, tables, images, captions, embedded
components and related links at desktop and mobile widths. Compare the source
and Typeroll preview, then a fresh authorized static build. Verify every inventory
URL and redirect, canonical/hreflang, sitemap inclusion, noindex state and assets.
Save working copies before publication. Keep the source host and DNS in place
until the candidate passes checks and the user authorizes its cutover.
