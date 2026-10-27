# Fluid typography and build feedback

Candidate: Core 0.2.114, MCP 0.45.85, template capabilities 0.55.0,
render version 10. Prepared on top of Core 0.2.113 security follow-ups.
Source: Ulvön F39–F41, wishlist at `bootingbots/ulvon-meta` commit `7d3131c`.
Not deployed by this implementation task.

## Boundaries and decisions

- Keep opaque-origin editor previews, SVG sanitization, session revocation,
  guarded outbound fetching and trusted release tooling from current main.
- Typography preview is a scriptless, opaque-origin iframe with a restrictive
  CSP. It renders synthetic text plus escaped site CSS, not customer HTML.
- Base size remains `fonts.size_base`. `typography` adds mobile/desktop ratios,
  spacing rhythm and prose line length. `design_scales` supports strictly
  validated clamp lengths and responsive steps using site breakpoints.
- New standard roles reference steps. Existing saved roles are not overwritten.
  Existing render versions keep their defaults. Authors explicitly upgrade a
  test Version and choose whether to reset roles with apply_standard_styles.
- Component titles never receive the editorial role's margins in version 10.
  Heading spacing expressed in em follows the heading and rhythm control.
  Explicit length/step overrides retain their own semantics.
- A queued step expires after 15 minutes without a claim, enforced on status
  reads and claims. A media continuation gets a fresh queued_at. No background
  polling or timeout-triggered replacement execution is introduced. CAS prevents
  expiration racing with a valid claim or completion. A running lease is not
  expired merely because the whole job is old.
- Jobs waiting for a previous publication report waiting_for_job_id and are
  not mislabeled as a Cloud Tasks worker outage. They do not supersede it.
- GitHub validation errors expose a safe classification, never provider bodies.
  The historical 422 log lacks a reason; the precise old cause is unknown.

## Verification and adoption

Tests cover scale validation and injection, responsive CSS, legacy output,
component spacing at 375/768/1280px, unsaved settings preview and persistence,
MCP schemas, settings section isolation, expiration/claim races and redacted
provider errors. The existing renderer manifest and complete settings are part
of publication render-cache keys; changed renderer/settings invalidate them.

Rebuilds do not occur automatically. Ulvön should upgrade a test Version to
render version 10, review fixed heading sizes, then adopt named roles/steps.
Only remove kort-rubrik/meny-rubrik/sektionsrubrik workarounds after comparing
actual cards and boxed headings. Old role margins and old fixed sizes remain
when render version 9 is retained. The starter QA script reports findings for
human review, not permission to rewrite customer design.

The public site-starter is generated from the released MCP workspace templates;
its sync must follow MCP 0.45.85 publication, not an unpublished local package.

## Local verification, 2026-10-26

- Release-plan, dependency audit, docs validation/format, all workspace typechecks:
  passed. Portal reports zero errors/warnings (existing informational hints remain).
- Infrastructure: 278 tests; MCP: 294; Portal: 3,619; Shared: 1,784 passed.
  The full gate initially found outdated version/progress assertions and a
  detached API-test worker; these were corrected and affected suites rerun.
- Eight Chromium/WebKit checks passed, including 375/768/1280px geometry,
  settings persistence, opaque sandbox and mobile panel overflow. Screenshots
  inspected locally; preview thumbnails fit the panel without changing their
  internal viewport width.
- Frozen Astro publication fixture passed for both trailing-slash policies.
  Responsive steps and typography survive projection; changing rhythm rejects
  old rendered-page cache entries. All 810 renderer reference tests pass,
  including unchanged snapshots for versions 1–9.
- Publication upgrade compatibility with Core 0.2.111–0.2.113, frozen template,
  complete workspace build and docs artifact preparation passed.
- No customer content, deployed environment or production publishing state was
  changed. The historical GitHub 422 reason cannot be recovered from its log.

## Domain cutover follow-up (F42), 2026-10-27

A promoted domain candidate retains its verified build artifact but gets a new
Git commit on main. Verification incorrectly inherited the build's old commit,
so the exact-identity completion guard rejected its event. New verification
tasks now use the current publication commit/branch; the immutable build is
unchanged and the completion guard remains strict.

A separate CNAME-to-A redirect failure came from retaining `flatten_cname` in
the expected after-image. Cloudflare removes that inapplicable setting. The
journal now normalizes only that known transition; unrelated setting, comment,
TTL, record and rule changes still block rollback. Regression tests cover
normal and lost-response writes, full restoration and concurrent edits.

The reported production job was resumed once, then failed on this second guard.
Both original CloudFront records were restored and independently read back.
The job is terminal and its approval cleared. A new candidate is needed after
the fix is deployed; do not reapprove or reuse the rolled-back journal. This
operational recovery is separate from deployment of the candidate code.
