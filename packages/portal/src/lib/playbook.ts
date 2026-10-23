/**
 * Starter playbook for the AI chat. Loaded on demand via the `read_playbook`
 * tool — kept out of the system prompt so it doesn't bloat every turn.
 *
 * These are the high-leverage patterns we've seen the AI struggle with or
 * solve inconsistently. Add to this file as transcripts surface new cases;
 * keep entries short — the AI is smart, it just needs the convention, not a
 * tutorial.
 *
 * External agents get the same recipes over MCP, rewritten for MCP tool
 * names: packages/mcp-server/skills/tr-edit-site.md ("Everyday requests") and
 * tr-seo.md (URL conventions, structured data). Change both when a convention
 * changes. The design reference is shared verbatim (design-notes.ts).
 */
export const PLAYBOOK_STARTER = `# Typeroll chat playbook

Patterns for handling common customer requests. Read the playbook when the
request matches one of the headings here — don't second-guess yourself, just
follow the recipe.

## Page identity & URLs

### "What's the URL for the about page?"
Call \`list_pages\`. Use the page's \`live_url\` and \`preview_url\` fields
directly. Never invent a domain like "your-site-url.com". If \`live_url\` is
null, tell the user why (page not published, or no domain configured on the
site) and offer the \`preview_url\` instead.

### "Send me a link to preview my draft"
Use \`preview_url\` from \`list_pages\`/\`read_page\`. Preview always works,
even for drafts and unpublished pages.

## Image attachments

The chat lets users drop, paste, or attach images directly. When an image is
attached, the request text includes a line like
\`[Attached image: https://cdn.typeroll.com/orgs/.../...png (filename: foo.png)]\`.

When you see one of these:
- The image is already uploaded. Use the verified media URL/reference exactly as given; never assume a particular hostname.
- If the user named a target, read that Page and its content mode. For blocks,
  use a standard image block or the existing hero's image field after reading
  its schema. Only for an existing HTML-mode Page, edit its complete HTML body.
  Do not switch a block-based Page to HTML to insert an image.
- If they just dropped the image without instructions, ask what they want
  done with it. Don't insert it into a random page.
- Preserve meaningful supplied alt text or describe the image's function in
  context. Decorative images may have empty alt; linked images need an
  accessible name. Ask when the image's purpose is unclear.

## Editing pages

### "Change the heading on the homepage to X"
1. Find the actual home Page in \`list_pages\`; do not assume a title or slug.
2. \`read_page\` / \`get_page_blocks\` before writing. Find whether the title
   comes from a shared template or the Page body; report shared impact first.
3. Use \`update_block\` for a block's declared heading field. Only use
   \`update_page_html\` for an existing HTML-mode Page, preserving the full body.
4. Keep one H1 and do not add a body title already supplied by the template.

### "Insert this image on the about page above [section]"
Read the Page and relevant block schema. Add/move a standard image block at the
requested position. Use the returned media URL, which may be on the customer's
own hostname. Preserve image proportions and unrelated content. Confirm its
location and provide the actual preview link returned by the tool.

### "Has the image been added yet?"
Don't trust prior chat turns. Call \`read_page\` and check the body. If the
user is confused about state, the page is the source of truth, not your
memory of what you did.

### "Add a new page called Pricing"
\`create_page\` with title="Pricing", slug="pricing", content_mode="blocks",
status="draft". Read the available types, then add standard blocks using their
declared fields. Do not invent prices or claims. Use the selected Page template
and avoid duplicating its title. Tell the user where to review the draft.

### "Publish the new page"
\`update_page_status\` with status="published". Mention that the live URL
won't be reachable until the next deploy.

## When the customer asks for a site-wide change

"Change all hero sections to use a gradient." "Add a CTA at the bottom of
every product page." "Put our phone number in the footer of every page."

These requests sound like bulk edits, but the right answer is almost never
"edit N pages in a row". It's composition:

1. Call \`list_partials\` to see what's already shared on this site
   (header, footer, plus any reusable free blocks).
2. If a relevant block already exists, edit that block — one save, every
   page that includes it updates. Call \`find_pages_using_block\` first to
   tell the customer the blast radius ("editing this block changes 8
   pages — go ahead?"). It also lists page templates and global blocks
   that contain it; a header or footer among them means every page.
3. If no shared block fits, create a reusable partial with editable standard
   blocks; reference it from the appropriate shared layout or Pages. For an
   existing HTML-mode Page, \`<x-include name="block-id" />\` references the
   partial. A new reusable design can be a custom block type with meaningful
   fields. Raw HTML is only a documented exception, such as a one-off layered
   animated hero; inspect breakpoints, accessibility and reduced motion.
4. Only fall back to editing each page individually when the change is
   genuinely per-page content (a different SEO description on every page,
   distinct hero copy on each landing page — things that can't share a
   single source). Even then: ask the customer to confirm the page list
   before fanning out, and prefer fewer, targeted edits over a sweep.

If the user said something like "all 23 pages" or "every page", treat
that as a strong hint that this belongs in a block. Reflect back what
you're about to do and wait for confirmation before mass-editing.

### Opportunistic extraction during a per-page sweep

Even when the user explicitly asked for per-page edits, watch for the same
HTML showing up on 3+ pages in a row. The moment you notice you're about
to paste (or already pasted) the same block of HTML into a third page,
**pause and offer to extract it into a reusable block** instead:

> "I notice I'm adding the same CTA to several pages. Want me to make it
> a reusable block (\`newsletter-cta\`) and embed it on those pages with
> \`<x-include>\`? Then future edits stay in one place."

Use \`list_blocks_with_usage\` to see what's already composable on this
site before suggesting a new one — if there's already a block that fits,
edit that instead of creating a new one. If the user agrees, create the
block with \`update_partial\` and rewrite the affected pages to embed it.

## Header, footer, free blocks

### "Add a link to /pricing in the menu"
1. \`read_partial\` partial_id="header" to see its content mode.
2. For blocks, read the navigation block's schema and update its links.
3. Check separate desktop/mobile compositions; change only the intended menus.
4. Only for an HTML-mode header, edit and write back its complete HTML.

### "Change the email in the footer"
\`read_partial\` partial_id="footer", then update the relevant block field.
Only edit full HTML when the existing footer is in HTML mode.

### "Make a reusable newsletter signup I can drop into any page"
Create a reusable partial with a native Form block and suitable layout blocks.
Reference it instead of duplicating content. Existing HTML Pages may use
\`<x-include name="newsletter-cta" />\`.

## Listings from Pages

### "Show our blog posts on the homepage"
1. Read content types and Pages to identify the article content type.
2. Read the homepage's block tree.
3. Add a \`core/page_list\` with \`content_type\`, sort and limit settings.
4. Save the page. The listing reads saved Pages at preview/build time and
   automatically includes later articles; never hand-generate listing HTML.

## Settings

### "Change our primary color to #ff5500"
\`update_site_settings\` with \`colors.primary = "#ff5500"\`. NOT a page edit.

### "Update the site logo"
\`update_site_settings\` with \`logo\` pointing at the CDN URL of the new
image. The customer must have already uploaded it (see \`list_media\`).

### "Add Google Analytics" / "add a chat widget script"
Analytics, advertising pixels and chat widgets are set by ID in the
**Integrations** app (**Settings → Apps → Integrations**), not pasted as scripts. Tell the
user to add the ID there and to turn on the cookie banner (**Settings**, "Enable cookie
consent on this site") so analytics and advertising wait for the visitor's
consent. The chat tools cannot write either. Only a tag the Integrations
catalog lacks goes in the cookie banner's optional scripts.

## Redirects

### "I renamed /about-us to /about, redirect the old URL"
\`create_redirect\` from "/about-us" to "/about" (status 301 unless the
user specified otherwise).

## Forms

### "Put the contact form on the contact page"
1. \`list_forms\` to find the form id.
2. **Block-mode page (the usual case):** \`add_block\` with
   \`{ type: 'core/form', data: { form_id: '<id>' } }\` — the block renders
   the form (simple fields-forms AND multi-step forms) with styled inputs,
   client-side validation, and the signed token handled for you.
3. **HTML-mode page only:** \`get_form_embed\` with that id — returns an
   \`<x-form>\` authoring reference; paste it into html_content. Preview and
   static generation expand it to the complete signed form shell.

NEVER hand-write a \`<form>\` element. The public submission endpoint rejects
anything without a valid HMAC token.

## URL and SEO conventions

When creating pages or moving them around, follow these conventions:

- **Slugs are kebab-case lowercase**: \`our-services\`, not \`Our_Services\`.
- **Use resolved routes and ancestry.** A slug is one segment. Nested addresses
  come from Page \`path\` or Content type routing; \`parent\` defines ancestry.
  Breadcrumbs use the resolved breadcrumb structure, not a split slug. Read the
  actual URL; never invent it from a Page title or ID.
- **Set \`kind: 'article'\`** on blog posts and news. This switches the
  page to \`og:type=article\` and emits Article JSON-LD with
  \`datePublished\`, \`author\`, \`publisher\`, and \`image\` — the rich
  result eligibility you want for content with a publish date.
- **Set the \`author\` field** on articles. Empty author = no
  \`Person\` schema = no author rich result.
- **SEO titles and descriptions** should be clear, accurate and useful.
  Do not impose fixed character counts, pad text or invent claims to meet them.
  Search engines may rewrite or truncate snippets.
- **OG image** matters per page, not just at the site level. For blog
  posts especially: the featured image makes the social share clickable.

When using the \`add_*_schema\` tools (FAQ, Recipe, Event), the tool writes
into the page's \`json_ld\` field. Don't hand-write JSON-LD when one of
the structured-data helpers exists.

## When you're unsure

- If the customer references a page or item by name and there are multiple
  plausible matches, ask before editing. One question is cheaper than an
  undo.
- If a tool refuses an operation, explain the specific missing permission or
  capability. Block-mode editing is supported; use its tools instead of claiming
  that it requires HTML conversion.
- If a request is outside what the tools allow (scripts, custom CSS, billing,
  user management), say so plainly and point them at the relevant area of
  the portal.
`;
