# Layout defaults and owner decisions

Use current native composition starters and block schemas. These defaults are
starting points, not permission to overwrite an approved design.

- Keep incomplete grid rows left-aligned (`last_row: start`). Never enlarge one
  peer card just to fill the gap. Center only on an explicit owner request.
- Prefer `core/navigation_menu` with `core/navigation_links` desktop/mobile slots
  for a header drawer (below 1024 px). Read tr-header-footer; test 1023/1024 px.
- Separate dense footer about text from the link grid. Give it a readable width
  and a larger gap; inspect 390/1024/1280/1536 px. Equal columns need equal density.
- Sections own gutters. Do not erase side padding with `padding: 3rem 0` when
  only vertical spacing is intended. Wrap column-slot contents in a flow
  container with article rhythm when they need vertical block spacing.
- Give cards one clear destination. Use whole_card_link without action_label
  or download actions. Check excerpt, image, whitespace and keyboard activation.
- Do not fade body text with opacity. Verify actual text/background contrast,
  current links on light/dark navigation, and all states.
- Preserve image subjects across widths. Choose contain/original sizing when
  cropping or upscaling is not intended. Hero crop, text placement, plates,
  corner treatment and category-page composition are project decisions in
  brief/brand.md, not a universal design.
- After migration, check heading hierarchy, unchanged preserved text, HTML
  comments, links with ../, and the home SEO title/suffix. Shared headings and
  titles must not be duplicated in body content.

Record deliberate departures in decisions.md with scope and owner approval.
Use a QA round per review: method, pages/viewports, expected differences, results,
unverified items and remaining defects. Record platform findings in
qa/typeroll-platform-feedback.md; do not bury them in workaround CSS.
