---
name: tr-redesign-branch
description: Use when the user asks to redesign, modernize, or restructure a Typeroll site (or a section of it). Forces branch-isolated work so the live site stays untouched until the redesign is approved.
---

# Redesign a site without breaking the live one

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


Site-wide changes are exactly where copy-on-write branches earn their
keep. This skill enforces the discipline: every redesign happens on a
branch, preview-checked end-to-end, merged only after user sign-off.

**Copy comes from the LIVE page, not a local draft.** A redesign changes
the design, not the words. Read the existing copy from the live page
(`read_page`/`batch_read_pages`) and carry it over verbatim. Local
`sources/*.md` files are drafts — use them only if the user explicitly
says "apply the copy in `<file>`". Don't invent new headlines, drop
sections, or "restore" text from an old draft; a draft that had drifted
from the live page once sent a whole redesign off the approved wording.
When you must change a word, change it on the live page too and keep the
draft file in sync.

**Restraint beats decoration.** Default to clean, purposeful design. Don't reach
for decorative motifs (suns, blobs, glows, mascots, confetti) to look "graphic" —
unless a motif *means something for this brand/page*, it reads as random, and it's
usually the exact thing that clips, seams, and crops. These fragile patterns broke
a real build — avoid them:
- **A shape divider (wave/curve) between two sections** → don't hand-roll it in
  `core/html`; a separate stacked shape seams against the next section (a Chrome
  sub-pixel hairline). Use `core/section`'s **`divider_top` / `divider_bottom`**
  (`wave | curve | tilt`) — the platform paints it in the section's own colour and
  overlaps the neighbour by 1px, so it's seam-free by construction. Put the divider
  on the section whose colour should rise/dip into the neighbour.
- **A glow/decoration inside an `overflow:hidden` box** → clipped to a hard edge.
  Put it in a non-clipped layer, or size it to fade out before the box edge.
- **`object-fit:cover` on a portrait inside a circle/frame** → crops heads and
  faces. Use `contain`, reframe the source art, or size the frame to the art.
- **A gradient "fade" at a section join** → reads as the design being cut off.
  Make transitions deliberate (a clean shape or a solid edge), never a fade.
These are invisible in a small full-page thumbnail and only show at real size in
the actual browser — see the review gate in step 6.

## Recipe

### 1. Discover (always)

```
get_site
read_site_settings
read_partial partial_id="header"
read_partial partial_id="footer"
list_pages limit=20
batch_read_pages page_ids=[<top 3-5 pages>]   # see actual conventions
list_partials                                  # what free blocks exist
list_collections                               # any data we need to consider
```

Write the user a short read-back: *"This is a 12-page agency site
using CSS variables, primary color #1e40af, Inter heading + Source
Sans body. Existing pages are content-dense, single-column. Main nav
has 5 items including a CTA. I'd suggest..."*

Confirm direction before touching anything.

### 2. Create a branch

```
create_branch name="<descriptive name>"
```

Save the response's `id` — pass it as `version=<id>` on every
subsequent call. Branches default `robots_blocked: true` so a
half-finished redesign won't be indexed.

### 2b. Write the design spec (REQUIRED — before you build)

Every redesign branch MUST carry a written design spec. Without it the
design choices live only in the agent's head, so a later "just tweak the
illustration style / palette" means re-deriving everything by hand (this
gap cost a real project a full reverse-engineering pass). Write it BEFORE
building so it guides the work, and keep it in sync as the design evolves.

Save it as a markdown doc with the project (e.g. `design-spec.md`, or
`prompts/design-system.md`) — or, if there's no local working dir, as an
unlisted page on the branch. It must capture:

- **Palette** — every role + hex (background, surface, primary, accent,
  text, borders), and where the variant *diverges* from the brand and why.
- **Typography** — fonts + weights/sizes per role.
- **Illustration / imagery style** — the exact image-gen prompt prefix
  (tone, palette, formspråk, framing rules), so the imagery can be
  regenerated or restyled on its own without touching layout. State the
  business/concept constraints the imagery must respect (a wrong-concept
  image is worse than none).
- **Section structure** — the page's sections in order + each one's
  treatment (band colour, layout).
- **Rationale** — one line per major choice: *why* this direction.

When the user later says "adjust just the illustrations" or "change the
palette", you edit the spec first, then apply — the spec is the source of
truth for the design intent.

### 3. Iterate on the branch

For each redesign step:

a. Make the change with `?version=<branch-id>`. Updates here don't
   touch main:

   ```
   update_partial partial_id="header" patch={...} version="<branch>"
   update_page page_id=home patch={...} version="<branch>"
   ```

b. Preview after every meaningful change:

   ```
   get_preview_link page_id=home version="<branch>"
   ```

   Send the URL to the user. The preview navigates the whole branch
   from one mint.

c. Iterate on feedback. Common rounds: headline tightening, color
   tweaks, swapping hero images.

### 4. Site-wide changes through partials, not pages

If the redesign touches every page (e.g. new global header, new
footer, new CTA bar) — edit a partial, not 23 pages. Before editing a
shared block, check the blast radius:

```
find_pages_using_block partial_id="header" version="<branch>"
```

This returns every page that would show the change. Communicate that
to the user before the save.

### 5. Bulk content cleanups via dry-run first

If the redesign requires content rewrites (e.g. "remove every mention
of the old company name"), use the bulk tool with dry-run:

```
search_pages contains="OldCo" version="<branch>"
bulk_replace_text pattern="OldCo" replacement="NewCo" dry_run=true version="<branch>"
# Show the user the sample_diffs
bulk_replace_text pattern="OldCo" replacement="NewCo" dry_run=false version="<branch>"
```

### 6. Approval round

**Self-review is a multi-DIMENSION pass, not a glance — and most of it you
MEASURE, not eyeball.** Structural checks (copy present, images return 200) are
NOT a design review; never report "approved" off them. Don't just list the bugs
you happened to notice — walk every dimension below on the DB-live preview
(a reused `get_preview_link`; browser tool + DOM reads), fix what you find,
reload, re-check. No re-deploy between fixes — the preview renders from the DB.

**Use `tr-design-review` (`read_skill tr-design-review`) for the HOW** — it has
the per-dimension measurement snippets (overflow ladder, computed contrast, touch
targets, the anti-lazy-load broken-image check) and the scorecard + verdict
format. The dimension summary below is the "what"; that skill is the runnable
routine. In particular: scroll-and-settle to trigger lazy images BEFORE any
full-page screenshot, or you'll report blank boxes that aren't real.

1. **Responsive** — screenshot across a width ladder (mobile / tablet / laptop /
   desktop / wide ≈390 / 768 / 1024 / 1440 / 1920px) AND sweep the page's own
   `@media` breakpoints (read the page-scoped `<style>`; resize a few px below +
   above each). At EVERY width: `document.documentElement.scrollWidth <=
   clientWidth` (no horizontal scroll), grids flip cleanly, nothing squished /
   orphaned / overlapping, no mid-word breaks. Two sizes is not enough — bugs hide
   in between. Also check a short/landscape viewport and 200% browser zoom.
2. **Visual & brand** — logo FULLY VISIBLE (not clipped by a header
   `overflow:hidden` + overlap margin) and brand-compliant; screenshot the header
   IN CONTEXT, never the logo element in isolation (that hides clipping).
   Decoration robust at real size in the real browser: no hairline seam at a
   divider (use `core/section` `divider_top`/`divider_bottom` — don't hand-roll a
   band), no glow clipped to a hard edge, no `object-fit:cover` cropping faces, no
   gradient fade-cutoff. Typography: body line-length ~45–75ch, consistent scale,
   no awkward widows on headings. Palette adherence (no off-brand colours);
   consistent spacing / alignment / radius / shadow.
3. **Accessibility — MEASURE, don't eyeball** — compute actual contrast ratios
   (WCAG AA: body ≥4.5:1, large/UI ≥3:1) and fix failures by deepening the
   offending colour token; meaningful `alt` on every image; exactly one `<h1>` +
   no skipped heading levels; visible `:focus-visible` on every interactive
   element; every input has an associated `<label>`; touch targets ≥44px on
   mobile; semantic landmarks (header/nav/main/footer) + nav `aria-label`; honour
   `prefers-reduced-motion`.
4. **Functional** — the form actually works (POST action correct, hidden token
   non-empty, honeypot present + hidden; a long name/email doesn't break layout);
   every link + in-page anchor resolves (each `#anchor` has a matching `id`; no
   `href="#"`/`""`); ZERO console errors/warnings; interactions (menu toggle,
   hover/focus/active) work.
5. **Content** — no unrendered `{{…}}` tokens in the DOM; no placeholder/lorem;
   copy still matches the source of truth (the live page) verbatim.
6. **Findable (SEO/meta)** — `<title>` + meta description present + sensible;
   `og:title`/`og:description`/`og:image`; canonical; favicon + apple-touch-icon;
   `<html lang>`; `noindex` correct (branches must be noindex).
7. **Fast (performance)** — images at sane sizes (not a 2048px file shown at
   380px without a responsive variant), modern format (avif/webp), `width`/`height`
   or aspect-ratio set (no layout shift), below-fold lazy / above-fold eager.
8. **Cross-browser** — the same CSS renders differently per engine (the divider
   seam was Chrome-only; WebKit/Firefox have their own). Re-check in another engine
   if you can; if only Chromium is available, statically flag risky props
   (`backdrop-filter` without fallback, `-webkit-`-only masks, `100vh` on mobile →
   prefer `100svh`, `sticky` inside `overflow`).

Fix what you find and re-check before involving the user. "Looks structurally
fine" ≠ "looks good", and "looks good in Chrome at 1440" ≠ "works for everyone,
everywhere" — never report a design as approved/perfect off a glance or a partial
pass.

Then give the user the **DB-live preview link** to review — and use the SAME
link for your own verification:

- **While iterating (default):** a reused `get_preview_link` (mint once,
  reuse — defaults to a 24h TTL). It renders from the database with NO build, so every
  edit shows on reload, and one link navigates the whole branch (internal
  links keep the token). The token URL is stable across edits — re-mint only
  when the 24h lapses, never per edit. Do NOT deploy just to let the user (or
  yourself) see a change.
- **When they want the COMPILED static site** (a permanent bookmark, a
  stakeholder link to the built output, or a final pre-merge check): deploy
  the branch once (`trigger_deploy version="<branch>"`) and share the stable
  alias `https://<branch>.<project>.pages.dev` (the `<project>` is the part
  after the hash in the returned `deploy_url`). Branch deploys are
  `robots_blocked`, so it won't be indexed. The immutable per-deploy
  `<hash>.pages.dev` is for your own one-off checks (a new hash each deploy).

Default: review/iterate on the reused DB-live preview; deploy only for the
compiled output or merge. Wait for an explicit "looks good, ship it."

### 7. Merge + deploy

```
merge_branch version_id="<branch>"        # branch's diffs land on main
trigger_deploy
get_deploy_status job_id=<id>             # poll until succeeded
```

Optionally, after a successful deploy:

```
delete_branch version_id="<branch>"       # tidy up
```

(You can also leave the branch around as a record of the redesign;
disk cost is tiny.)

## Pitfalls

- **Forgetting `version=` on writes.** Every call you make on the
  branch must include `version=<branch-id>`. A missing one writes
  straight to main — silent and bad.
- **Skipping discovery.** "Modernize" without first reading the site
  produces a confidently-out-of-place result. Always sample existing
  pages.
- **Deploying to preview.** Don't `trigger_deploy` after every edit just to
  see the change — that builds static pages and the URL is only as fresh as
  the last build. Iterate on a reused DB-live `get_preview_link` (renders from
  the DB, reflects edits on reload); deploy only for the compiled static
  output or merge (steps 6–7).
- **Auto-merge.** Don't `merge_branch` without explicit user sign-off.
  Once merged, the only undo is another branch + reverse edits.
- **Header rewrites that drop the brand block.** Even when the
  redesign is dramatic, preserve the brand mark + the nav skeleton
  unless the user said to redo them.

## When to NOT use a branch

Tiny edits — "fix the typo on the About page" — don't need a branch.
The in-portal chat handles those directly on main. This skill is for
work where:

- The user might want to walk away mid-redesign and come back later
- Multiple changes need to ship together
- The site is high-traffic and "broken for an hour" is unacceptable
- Stakeholder review across multiple pages is expected

If none of those apply, edit main directly and move on.
