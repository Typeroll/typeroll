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
