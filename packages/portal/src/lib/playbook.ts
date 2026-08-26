/**
 * Starter playbook for the AI chat. Loaded on demand via the `read_playbook`
 * tool — kept out of the system prompt so it doesn't bloat every turn.
 *
 * These are the high-leverage patterns we've seen the AI struggle with or
 * solve inconsistently. Add to this file as transcripts surface new cases;
 * keep entries short — the AI is smart, it just needs the convention, not a
 * tutorial.
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
- The image is already uploaded to the CDN. Use the URL exactly as given.
- If the user named a target ("insert on the about page", "use as the
  homepage hero"), \`read_page\` that page, insert
  \`<img src="…" alt="…" style="width:100%;height:auto;display:block;margin:2rem 0;" />\`
  in the right spot, write back the full HTML.
- If they just dropped the image without instructions, ask what they want
  done with it. Don't insert it into a random page.
- Ask the user for alt text if they didn't supply any — it's bad for SEO
  and accessibility to leave it blank.

## Editing pages

### "Change the heading on the homepage to X"
1. Find the home page in \`list_pages\` (slug "home" or empty).
2. \`read_page\` to fetch its current HTML.
3. Edit only the \`<h1>\` (or relevant heading) in the body and write back the
   FULL HTML via \`update_page_html\`. Don't paste a stripped version.

### "Insert this image on the about page above [section]"
1. \`read_page\` for the page.
2. Locate the section's heading in the HTML.
3. Insert \`<img src="…" alt="…" style="width:100%;height:auto;display:block;margin:2rem 0;" />\`
   immediately before that section's wrapper.
4. ALWAYS use the cdn.typeroll.com URL from \`list_media\` — never guess.
5. After saving, confirm with the user where it landed (a one-line summary,
   not the HTML).

### "Has the image been added yet?"
Don't trust prior chat turns. Call \`read_page\` and check the body. If the
user is confused about state, the page is the source of truth, not your
memory of what you did.

### "Add a new page called Pricing"
\`create_page\` with title="Pricing", slug="pricing", content_mode="html",
status="draft" (always default to draft). Then \`update_page_html\` with a
minimal but realistic starter body — heading + intro paragraph + one
content section. Tell the user where to take it from there.

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
   pages — go ahead?").
3. If no block fits, propose creating a free block (\`update_partial\` with
   a kebab-case id) and embedding it on the right pages with
   \`<x-include name="block-id" />\`. Don't paste the same HTML into
   multiple pages — that's the bug, not the fix.
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
1. \`read_partial\` partial_id="header" to see the current structure.
2. Locate the \`<nav>\` (or list of nav links).
3. Insert a new \`<a href="/pricing">Pricing</a>\` in the right spot.
4. Write back the FULL header HTML via \`update_partial\`.

### "Change the email in the footer"
\`read_partial\` partial_id="footer", swap the email, write back the full
HTML.

### "Make a reusable newsletter signup I can drop into any page"
\`update_partial\` with a kebab-case id like "newsletter-cta" and the full
HTML. Then tell the user how to embed it: \`<x-include name="newsletter-cta" />\`
in any page's html_content. Don't paste the HTML inline on each page.

## Listings from collections

### "Show our blog posts on the homepage"
1. \`list_collections\` to find the blog collection.
2. \`list_collection_items\` with collection=name. Sort by date if present.
3. \`read_page\` for the homepage.
4. Hand-write a listing block in the page body (semantic HTML, the site's
   CSS variables) referencing the actual items by title, date, slug, image.
   The static site has no template engine — what you write is what ships.
5. Write back via \`update_page_html\`. Tell the user that adding new posts
   later won't auto-update this listing; offer to regenerate on request.

## Settings

### "Change our primary color to #ff5500"
\`update_site_settings\` with \`colors.primary = "#ff5500"\`. NOT a page edit.

### "Update the site logo"
\`update_site_settings\` with \`logo\` pointing at the CDN URL of the new
image. The customer must have already uploaded it (see \`list_media\`).

### "Add Google Analytics" / "add a chat widget script"
These live in \`scripts_head\` or \`scripts_body_end\` site settings — but the
chat tools DO NOT have write access to those fields. Tell the user to paste
the snippet themselves in **Settings → Scripts**.

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
- **Reflect hierarchy in the slug** when content is nested. A team-member
  page lives at \`/team/jane-doe\`, not at \`/jane-doe\`. The breadcrumb
  schema is derived from the slug, so the hierarchy you encode here shows
  up in Google's breadcrumb rich results.
- **Set \`kind: 'article'\`** on blog posts and news. This switches the
  page to \`og:type=article\` and emits Article JSON-LD with
  \`datePublished\`, \`author\`, \`publisher\`, and \`image\` — the rich
  result eligibility you want for content with a publish date.
- **Set the \`author\` field** on articles. Empty author = no
  \`Person\` schema = no author rich result.
- **SEO title** target: 50-60 chars. Longer gets truncated in Google. The
  editor shows a warning past 60.
- **Meta description** target: 150-160 chars. Don't write fluff to fill
  it; descriptions Google rewrites itself when you go off-topic.
- **OG image** matters per page, not just at the site level. For blog
  posts especially: the featured image makes the social share clickable.

When using the \`add_*_schema\` tools (FAQ, Recipe, Event), the tool writes
into the page's \`json_ld\` field. Don't hand-write JSON-LD when one of
the structured-data helpers exists.

## When you're unsure

- If the customer references a page or item by name and there are multiple
  plausible matches, ask before editing. One question is cheaper than an
  undo.
- If a tool returns an error, surface what the user can do about it (e.g.
  "the page is in blocks mode, edit isn't supported yet"), not just the raw
  message.
- If a request is outside what the tools allow (scripts, custom CSS, billing,
  user management), say so plainly and point them at the relevant area of
  the portal.
`;
