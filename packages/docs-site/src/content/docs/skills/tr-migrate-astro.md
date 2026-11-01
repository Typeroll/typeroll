---
title: "Migrate an Astro site"
description: "Migrate an existing Astro site, including Astro Content Collections, to native Typeroll Pages and Content types while preserving routes, design and media."
editUrl: "https://github.com/typeroll/typeroll/edit/main/packages/mcp-server/skills/tr-migrate-astro.md"
sidebar:
  label: "Migrate from Astro"
  order: 21
---

<!-- Generated from packages/mcp-server/skills/tr-migrate-astro.md by scripts/generate-skill-pages.mjs. Edit the skill, not this page. -->

This is the `tr-migrate-astro` recipe exactly as the Typeroll MCP server gives it to agents through `list_skills` and `read_skill`. See [Skills and recipes](../overview/) for how agents load recipes.

**Who runs this:** this recipe is for the user's own AI agent (Claude Code, Codex or
another MCP client) working through MCP and the public API. The portal's built-in
AI assistant has no migration tools: it does not import, convert or verify sites.

**Before import or reconstruction:** read `tr-migration-evidence` with
`read_skill`. Choose preserve or renew independently for text and design/images,
record text_intent and design_intent in the brief and verify one prototype per active template before bulk writes.
Use standard blocks first, reviewed custom types next, rare documented HTML last.
All four combinations must preserve or meaningfully redirect every old public URL. That
shared contract defines acceptance; this recipe only adds source-specific steps.


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

## Launch basics (ask early)

Ask the user for these once, early in the project. Read `read_site_settings` first and ask only for
what is missing. Each item is optional. Record a skipped item in
`decisions.md`, so the launch check in the last step holds no surprises.

- **Default share image.** Ask the user to choose or create the image that
  social networks and chat apps show when a page has no image of its own:
  upload one (`create_upload_url` or `upload_media_from_url`), pick an existing
  one (`list_media`), or create one with `tr-imagegen`. Use a 1200×630 px PNG or
  JPEG and set it as `default_og_image` with `update_site_settings`. Never
  generate a title card from the page title instead. The user may skip this.
- **Organization.** The business name, logo and official profile URLs
  (LinkedIn, Instagram, GitHub and similar). Set `organization` with `same_as`;
  it becomes the home page's Organization schema.

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
  Do not copy client scripts; analytics and advertising tags move to the
  Integrations app behind the cookie banner (tr-migration-evidence, "Scripts,
  tracking and consent").

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

## Launch (required)

A site is not finished until this step has run. Call `read_site_readiness`
before the production publication and again after it. For every item with the
status `warning` or `suggestion`, either fix it with the tool its `fix` names,
or record in `decisions.md` (or the starter's `qa/` folder) why it stays open.
Tell the user which items remain. A missing default share image is only a
suggestion; leave it if the user chose to skip it.

The report warns and never blocks a publication. A clean report is not approval
to publish: publish only when the user has approved it.

Publish only after the URL inventory, `verify_migration_urls` and
`get_migration_launch_report` pass, and the user approves:

```
read_site_readiness
trigger_deploy
get_deploy_status job_id=<id>
```

The readiness report does not replace the migration launch report.

Run `read_site_readiness` again after the publication. It reads saved content
and settings, so confirm the rest on the live site: the AI crawler zone check
needs the site's website host, and a Search Console property verified by DNS
is not visible to Typeroll. The
[launch checklist](https://typeroll.com/docs/guides/launch-checklist/)
explains every item.
