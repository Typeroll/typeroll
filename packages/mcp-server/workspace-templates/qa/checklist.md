# Verification

- Confirm Organization, Site, Version and deployed/source identity.
- Run `python3 scripts/typeroll/check_unsaved.py` before trigger_deploy. Review
  and explicitly save authorized Pages and partials; templates save immediately.
- Compare preserved text with capture_text.cjs + compare_text.py and an explicit
  selector. Check intentional additions, source comments and images separately.
- Inspect desktop/mobile previews and actual hosted output around breakpoints.
  Use shootframe.cjs / shoot_hosted.cjs and inspect full screenshots, not only tiles.
- Exercise menus, keyboard focus, current links, forms and enabled app states.
  Use card-stacking-check.cjs for whole-card excerpt/media/whitespace targets.
- Check actual contrast on light/dark/photo backgrounds, image subjects and
  sharpness, footer balance, left-aligned last rows and heading hierarchy.
- Check home title/suffix, metadata, canonical/indexing policy and JSON-LD.
- Run check_url_parity.py and check_assets.py on the deployed candidate; compare
  final targets with the approved URL map and flatten accidental redirect chains.
- Treat 403/network/DNS failures as unverified. Do not claim search-bot access
  from a user-agent string or turn off customer protection without approval.
- Record tested pages, viewports, revision, results and unresolved issues per QA
  round. Record product defects in qa/typeroll-platform-feedback.md.
- Keep screenshots and private runtime reports in ignored qa/reports/.
- Check publishing readiness and migration launch report. Passing technical
  validation does not prove visual/editorial completeness or grant launch approval.

Commands/dependencies/limits: scripts/README.md. Design: workflows/design.md.
Follow existing owner authorization; test publication, traffic cutover and
indexing have distinct effects but do not require repeated approval if covered.


- [ ] Check heading role spacing, slot gap and responsive vertical padding in the browser.
- [ ] Review global/current navigation colors against the real parent background.
- [ ] Check intrinsic-width image and full-image hero framing at breakpoint boundaries.
- [ ] Test click-to-load video with keyboard; no provider request before activation.
- [ ] Review matched drafts, unpublished targets and redirect chains before launch.
- [ ] Explicitly save working copies, or obtain approval to publish saved content only.

## Design tokens (Core 0.2.106+)

- [ ] Run `lint_design_tokens` before launch and after major design changes.
- [ ] Review hardcoded colours, fonts and sizes; record justified exceptions in decisions.md.
- [ ] Dry-run colour migration; do not infer semantic roles from equal hex values.
- [ ] Change primary and surface in a test Version: header, footer, cards, menus and buttons follow without block edits at mobile/tablet/desktop widths. Restore the test settings.
- [ ] Report actual versus simulated before/after counts separately; do not claim a migration was applied from a dry run.

- [ ] Before source retirement, review workflows/source-media.md: unused originals,
  print files, private archive manifest, verified copies and a restore test.
- [ ] Review ICC-converted derivatives visually; preserve originals separately.
- [ ] Verify Analytics configuration and actual beacon/cookie behavior after build.
- [ ] Read domain publication intent before deployment; distinguish test-host
  updates, future-host candidates and explicit traffic approval.
- [ ] Inspect the frozen candidate's noindex/robots output, not only current CMS settings.
- [ ] Review owner facts and dates against the chosen preserve/renew text policy.

## Internal Page notes

Follow workflows/page-notes.md and pages/README.md. Create notes during migration,
read before edits, update afterward, check external links at each editorial review,
and archive notes for confirmed removed Pages under pages/archived/. Refreshing
generated facts never counts as a completed review. Keep notes out of public output.

- After a Core rendering upgrade, compare typography and spacing at 375, 768
  and 1280px. Opening headings in cards, boxes and sections must not add the
  editorial heading's top margin. Check actual fonts as well as the Site settings
  scale preview. Run `node scripts/typeroll/check_heading_spacing.cjs <origin>`
  and review deliberate exceptions in decisions.md.

### Sharing metadata

Compare saved full source and deployed target HTML with
`python3 scripts/typeroll/compare_seo.py qa/source.html qa/target.html`.
The report includes document metadata, `og:image`, `og:title`,
`og:description` and Twitter tags, including missing and duplicate tags.
Record intentional differences; an image URL changed by migration needs review
against the media mapping, not automatic approval. This script does not fetch
pages or change content. Keep source snapshots free of private data.

From Core 0.2.120 / MCP 0.45.90, preserve distinct sharing text in Page
`og_title` and `og_description`. Empty fields use SEO metadata. The public
content-type field mapped to Schema.org `image` supplies the image after
`og_image`, before site defaults. Its `<field>_alt` supplies the image description
when public; `seo_image_alt` is the explicit override. Never copy a site logo
into every Page merely to reproduce an old fallback.
