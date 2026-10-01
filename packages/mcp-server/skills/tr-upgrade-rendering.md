---
name: tr-upgrade-rendering
description: Use when a site's platform render version is behind the latest (read_site_settings → render.version < render.latest), or the user asks to "upgrade rendering", "get the new block styles" or why a platform improvement doesn't show. Compares every page at the current and target version with screenshots, reports the differences and upgrades only with approval.
---

# Upgrade a site's render version

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

3. **Mint two links per page set.** One `get_preview_link` without
   `render_version` (current) and one with `render_version: latest` (target).
   Both show saved content. Mint each once and reuse it; internal links keep
   the token.

4. **Screenshot both** at 390, 768 and 1440 px wide, full page, after fonts
   and images have loaded (`document.fonts.ready`, scroll to the end to
   trigger lazy images, then back to the top). Use a headless browser with a
   fixed viewport and `reducedMotion: 'reduce'`.

5. **Compare.** Pixel-diff each pair (same size, small per-pixel tolerance)
   and record the changed area and the bounding boxes of changed regions.
   Crop each region from both versions. Ignore differences confined to
   embedded third-party frames (maps, booking widgets, video).

6. **Report** per page and width: unchanged, or the cropped before/after
   regions with a one-line description ("links in body text are underlined",
   "section gap 8px larger"). Link each change to the version note that
   explains it. Say plainly when a change looks like a regression.

   Before screenshots, read the site and page custom CSS for selectors a
   version note names. Version 2 moves a heading's or button's custom class
   onto the `<h2>` or link, so `.my-class .block-heading-text` stops
   matching; propose the rewrite (`.my-class`) or a named style.

7. **Ask before upgrading.** Never upgrade on your own. If the user wants to
   keep a specific old look, solve it with a site style or page CSS first and
   compare again.

8. **Upgrade** with `update_site_settings render_version: <latest>` (pass
   `version` to do it on a branch first). The preview changes at once; the
   live site changes at the next deploy. To undo, write the previous number.

## Pitfalls

- Comparing a draft against saved content shows content edits, not
  rendering changes. Use the same content state for both links.
- Lazy images and web fonts cause false differences. Wait for them in both
  screenshots.
- Comparing only the home page misses changes in components it doesn't use.
- Don't encode a workaround in custom CSS to resist an upgrade without
  telling the user; it becomes a hidden fork of the platform styles.
