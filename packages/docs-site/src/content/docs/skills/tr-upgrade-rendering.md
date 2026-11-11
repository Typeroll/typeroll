---
title: "Upgrade a site's render version"
description: "Use when a site's platform render version is behind the latest (read_site_settings → render.version < render.latest), or the user asks to \"upgrade rendering\", \"get the new block styles\" or why a platform improvement doesn't show. Compares every page at the current and target version with screenshots, reports the differences and upgrades only with approval."
editUrl: "https://github.com/typeroll/typeroll/edit/main/packages/mcp-server/skills/tr-upgrade-rendering.md"
sidebar:
  label: "Upgrade rendering"
  order: 9
---

<!-- Generated from packages/mcp-server/skills/tr-upgrade-rendering.md by scripts/generate-skill-pages.mjs. Edit the skill, not this page. -->

This is the `tr-upgrade-rendering` recipe exactly as the Typeroll MCP server gives it to agents through `list_skills` and `read_skill`. See [Skills and recipes](../overview/) for how agents load recipes.

Platform changes to block markup and shared CSS ship as numbered render
versions. A site keeps its version until someone upgrades it, so its look
never changes on its own. Upgrading is a single settings write, reversible by
writing the previous number. The comparison happens here, in the agent; the
server only renders previews.

The user can also do this in the portal: Settings → Rendering → "Preview with
version N", then "Upgrade". Offer this skill when they want a full-site visual
comparison first.

## Recipe

1. **Read the gap.** `read_site_settings` returns `render`:
   `{ version, latest, upgrades: [{ version, title, changes[] }] }`. If
   `version === latest`, stop. Tell the user what each pending version
   changes, in their words, before measuring anything.

2. **List the pages to compare.** `list_pages` (published and unlisted), plus
   the header/footer, which appear on every page. For a large site, compare
   the home page, one page per content type and template, and every page
   whose blocks use a component named in `upgrades[].changes`.

3. **Mint two links per page set, before upgrading.** One `get_preview_link`
   without `render_version` (current) and one with `render_version: latest`
   (target). Both show saved content. Mint each once and reuse it; internal
   links keep the token. Put the page's path in each link (`page_id` or
   `slug`) and capture its `frame_url`, the rendered page without the preview
   wrapper. Compare these two, never the live site after the upgrade: once
   upgraded and published, the old look is gone and regressions hide in it.

4. **Screenshot both** at 390, 768 and 1440 px wide, full page, after fonts
   and images have loaded (`document.fonts.ready`, scroll to the end to
   trigger lazy images, then back to the top). Use a headless browser with a
   fixed viewport and `reducedMotion: 'reduce'`. Also record computed boxes
   (top, height, margin, padding, gap) of each section and heading, for
   example with the starter's `layout_trace.cjs`. On your own computer, load
   pages slowly; home connections can throttle many rapid requests (the
   starter's browser tools pace page loads). Use a cloud session for large sites.

5. **Compare.** Pixel-diff each pair (same size, small per-pixel tolerance)
   and record the changed area and the bounding boxes of changed regions.
   Crop each region from both versions. Compare the computed boxes too: a
   vertical shift (content moved up or down) is a difference even when each
   block looks the same. Ignore differences confined to embedded third-party
   frames (maps, booking widgets, video).

6. **Report** per page and width: unchanged, or the cropped before/after
   regions with a one-line description ("links in body text are underlined",
   "section gap 8px larger"). Link each change to the version note that
   explains it. Say plainly when a change looks like a regression.

   Before screenshots, read the site and page custom CSS for selectors a
   version note names. Version 2 moves a heading's or button's custom class
   onto the `<h2>` or link, so `.my-class .block-heading-text` stops
   matching; propose the rewrite (`.my-class`) or a named style.
   Version 16 wraps a form's buttons in `.form-actions`, so CSS that placed
   the button in the form grid targets `form > .form-actions`. Version 17
   loads weights written in CSS: propose removing `fonts.load` entries that
   only existed for them, and element rules that were scoped only to keep
   them off the cookie banner. Version 19 moves the cookie banner's reopen
   control from the floating "Cookies" button to a "Cookie settings" link at
   the end of the footer, unless the footer already links to
   `#cookie-settings`: check the footer bottom at every width, remove CSS that
   only moved or hid `.tr-consent__manage`, and ask whether the user wants
   `cookie_consent.manage_button: "floating"` to keep the button. Any rule that targets platform markup
   (`.block-section-inner`, `[data-block=...]` internals) can change with a
   render version: prefer block settings and named styles, and re-check such
   rules at all three widths after the upgrade.

7. **Ask before upgrading.** Never upgrade on your own. If the user wants to
   keep a specific old look, solve it with a site style or page CSS first and
   compare again.

8. **Upgrade** with `update_site_settings render_version: <latest>` (pass
   `version` to do it on a branch first). The preview changes at once; the
   live site changes at the next deploy. Run `trigger_deploy` with
   `dry_run: true` and read `get_publication_impact` first: the deploy also
   ships every other saved change. To undo, write the previous number.

## Platform fixes behind a newer version

When a layout defect is fixed in a newer render version (for example version
12: constrained containers fill column layouts), the fix is to raise
`render_version` through steps 3–8 — compare, report, upgrade with approval,
then publish. Do not work around it in content (extra wrappers, widths,
paddings or custom CSS); those workarounds outlive the fix and fight it.

## Pitfalls

- Comparing a draft against saved content shows content edits, not
  rendering changes. Use the same content state for both links.
- Lazy images and web fonts cause false differences. Wait for them in both
  screenshots.
- Comparing only the home page misses changes in components it doesn't use.
- Comparing against the live site after upgrading hides regressions: the
  baseline is gone. Capture both previews before the upgrade.
- Don't encode a workaround in custom CSS to resist an upgrade without
  telling the user; it becomes a hidden fork of the platform styles.
