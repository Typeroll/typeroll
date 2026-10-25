# Ulvon migration feedback: disposition and follow-up

Source: bootingbots/ulvon-meta, main, `qa/typeroll-starter-wishlist.md`,
`qa/typeroll-platform-feedback.md` and `scripts/typeroll/`, read 2026-10-25 at source commit `71ee0c8fcb6d5eff8ba2f14ae4c012c833198437`.
The source wishlist mentions an older feature branch; this review uses main as
requested. F1–F32 are source report identifiers, not new GitHub issues.

## Scope and delivery

Core owns the canonical workspace generator and public recipes. site-starter is
a generated distribution of **released MCP**, not a second source of instructions.
This change adds the tools to `packages/mcp-server/workspace-templates`, bundles
and tests them for `init --update`, and prepares site-starter's path validator to
accept them after the matched MCP release. Do not publish an unreleased template
under an older released lock/version. Customer-edited files remain preserved.
No customer content, hosting, DNS or deployment is changed by this task.

## What is adopted from sections 1–2

- MCP helper, shell call, unsaved-copy gate, URL parity, asset checks, bulk-block
  example, preview/hosted screenshots, contact sheets and spacing trace.
- Explicit portal/Organization/Site/Version binding and schema discovery replace
  hardcoded hosting/default-main assumptions. Mutations have no blind retry.
  Uploads fail closed on missing/mismatched finalize SHA-256 evidence.
- URL checks retain redirect hosts, query parameters and spellings, detect loops,
  reject unrelated redirect hops for preserved Pages, and report access failures.
  Asset discovery resolves URLs relative to the actual page. Neither checker
  claims that spoofing a browser or crawler proves access for search engines.
- Block sweeps remain examples/dry-run by default, refuse existing unsaved work,
  and save both Pages and partials. They do not offer transactional rollback.
- Text capture/diff accepts an explicit content selector and saved HTML or one
  WP REST record. It excludes comments/scripts/styles, includes the source title
  explicitly, and never invents text or auto-accepts differences. Full automatic
  per-site source mapping/semantic comparison remains future work.
- Card stacking check is generalized to all whole-card blocks, no site text or
  fixed company selector. Large cards outside the sampled viewport are unverified.

Not copied as production starter code:
- wp2blocks/build_page/spec generators/alt lists: site layout and Elementor rules,
  source URL mappings and owner-approved copy changes need an explicit reusable
  adapter contract and fixtures before distribution. They remain reference code.
  A generic converter must not silently drop layout, rewrite preserved text or
  become a parallel CMS state store.
- redirects.py: site-specific mutation list; keep the authoritative inventory and
  redirects in CMS. Adopt the chain-check routine now, design a reviewed CSV/JSON
  mutation helper later with dry-run, conflict detection and version binding.
- herotest.js: the wishlist describes pixel-based contrast sampling, but the
  script on main measures heading/background geometry and screenshots only. It
  assumes the first H1, a background-image ancestor and an arbitrary iframe. Keep
  its measurement ideas in visual QA; generalize the selectors and fixtures before
  shipping it, and do not claim a photo-contrast pass from these measurements.
- wordmark.py: font licensing and glyph/shaping dependencies vary. Document SVG
  as an option; do not make font conversion a universal starter requirement.
- Site-specific scripts from section 3 and exact hero/category layouts are not
  adopted. Footer balance, reading edge and subject preservation are general;
  plates, square corners and specific column recipes are owner design choices.

## Priorities and all 32 findings

P0 blocks this launch; P1 should be the next product batch; P2 requires a scoped
contract/design or focused reproduction. "Reported" means the original evidence
is recorded, not that the current production defect was reproduced here.

| ID | Priority | Decision / current evidence |
| --- | --- | --- |
| F1 | Implemented / documented | Implemented: column slots use a consistent flow gap, with responsive content_gap_px. Nested grid/card layouts remain independent. |
| F2 | Implemented / documented | Implemented: heading role space_before/space_after emit base and breakpoint margins instead of silently disappearing. |
| F3 | Implemented / documented | Implemented bounded checks: tree writes check global and instance part styles against known ancestor background colors. Photographs, gradients and arbitrary CSS still require rendered review; this is not a photo-contrast guarantee. |
| F4 | Implemented / documented | Instruction change: CSS padding shorthand remains standard CSS. Use padding-block or padding_y_px for vertical-only changes; never silently reinterpret a shorthand. |
| F5 | Included | Recommend navigation_menu plus navigation_links slots; explicit drawer breakpoint and keyboard/boundary checks. |
| F6 | Implemented / documented | Implemented native text wordmark and per-instance image override in template/site_logo; header/footer can use separate assets. No mandatory font-to-SVG conversion. |
| F7 | Implemented / documented | Implemented in self-host GCP provisioning/doctor required API list. Managed Cloud enablement was reported already done; this task does not change production GCP services. |
| F8 | Implemented / documented | Implemented: denied Search Console requests identify exact property and service identity and explain read access/API enablement/CSV fallback. No silent property substitution. |
| F9 | Implemented / documented | Implemented bounded public WordPress REST discovery (including exposed custom types) and opt-in same-origin crawling, in API/MCP and Migration URLs UI. Limits and incomplete coverage are explicit; authoritative historical inventories remain required. |
| F10 | Implemented / documented | Retain explicit Organization/Site selection and scoped credentials. A site-bound key cannot switch Organizations; use an authorized OAuth connection or a separately configured key. No broadened grant or implicit tenant fallback. |
| F11 | Implemented / documented | Document the existing REST/MCP envelopes and working-copy save boundary. Helpers unwrap only known responses. Renaming every envelope would break clients without improving migration correctness. |
| F12 | Implemented / documented | Implemented frame_url in get_preview_link response, same signed ticket and sandbox, fresh bridge nonce. Rendering QA may open it directly; extension/host-protocol QA uses the normal wrapper. |
| F13 | Included initial tool | Explicit-region preserved-text diff. Automatic source-to-page matching and semantic/content completeness still require review. |
| F14 | Included | About column separate from link grid; inspect density and intermediate desktop widths. No universal pixel sizes. |
| F15 | Implemented / documented | Implemented same-origin resolved URL matching for current navigation, with external-root and relative-link coverage. Static and preview pass the real site origin. |
| F16 | Fixed locally | Reproduced API success with dropped flag. PAGE_WC_FIELDS omitted append_seo_suffix; now stages/saves false/true/null. Existing preview/static renderers already honor false. API regression fails before fix. |
| F17 | Implemented / documented | Implemented post_card image_alt editor/schema exposure; preserves explicit decorative alt and existing accessible link-name fallback. No ambiguous media-library lookup: map image_alt_field explicitly for listings. |
| F18 | Implemented / documented | Implemented full-image hero heading color inheritance; known-background part checks plus browser review. Image contrast still requires author judgement at every breakpoint. |
| F19 | Included | Public REST/HTML vs authenticated helper decision table; no unnecessary install. WordPress.org listing is separate review/publication work. |
| F20 | Implemented / documented | Implemented opt-in never_upscale on core/image. Original/contain choices remain independent; explicit crop or enlargement is an owner choice. |
| F21 | Implemented / documented | Implemented responsive hero focal point, aspect ratio, fit, vertical text position and alignment; container background focal point/fit. Browser coverage includes narrow/wide boundaries. |
| F22 | P0 fixed locally | Remove excerpt/meta opacity, isolate whole-card stacking and raise its stretched link; warn about incompatible secondary actions. Browser clicks/contrast at 390/768/1280; no customer CSS. Requires Core release + customer's normal rebuild before launch acceptance. |
| F23 | Implemented / documented | Implemented click_to_load video facade with accessible keyboard button, optional explicit poster, no automatic external thumbnail and no provider iframe until activation. Existing embeds remain opt-in compatible; this is not a general consent manager. |
| F24 | Implemented / documented | Implemented matched_draft inventory status and unpublished_targets in internal-link reports. These do not count as successful deployment coverage and remain launch blockers. |
| F25 | Included | Parse and exclude HTML comments before text extraction/reconstruction. Text checker regression covers comments and scripts. Do not promise every server importer was changed. |
| F26 | Included | last_row:start is default; centering only on explicit owner request. No stretched peer to fill gaps. |
| F27 | Implemented / documented | Implemented exclusion of style metadata during link extraction and separate unpublished-target reporting, including draft sources. Arbitrary HTML/custom-block semantics still require artifact/hosted validation. |
| F28 | Implemented / documented | Implemented exact-job build_progress with attempt/file counters (no runner secrets), UI display, public DNS fallback and explicit verifier-access failures. No new watchdog/retry timer, no bot impersonation, no claim that a blocked verifier proves missing content. |
| F29 | Implemented / documented | Implemented responsive section padding_y. Use mobile/tablet/laptop/desktop/wide keys, not base. New fields are discoverable through read_block_type; invalid schema values retain existing warnings. |
| F30 | Implemented / documented | Keep established target envelopes/IDs/pagination; document canonical calls. Fix status-only batch saved reporting and expose staged/applied_immediately fields. Template writes remain immediate; no misleading template working copies or breaking API-wide aliases. |
| F31 | Implemented / documented | Implemented HTTP 409 unsaved_content before queueing, target-only metadata, explicit allow_unsaved confirmation in MCP/API and portal. Confirmation publishes saved content only; it never saves another editor’s work. |
| F32 | Implemented / documented | Implemented redirect-chain/loop warnings on write, in Redirects UI and migration launch report, plus hosted parity checks. No automatic rewrite of intentional redirects. |

## Acceptance and release boundaries

Local synthetic tests cover the new helper's binding, pagination, redirect query/
cross-origin behavior, loops, assets and upload integrity; browser tests exercise
F22 using the shared renderer and real CSS. Text/working-copy tests cover F16/F25.
No tests here prove current ulvon production, search-engine access, or every source
adapter. Preserve the original migration evidence; recheck the actual candidate
site after the matching Core release and customer-authorized publication.

The prior guided-domain PR is separate. Coordinate artifact versions with that
pending release; do not assign two different sources the same Core/MCP version.

## Verification of first candidate ab8df71

The expanded candidate below requires its own release gate; these numbers are the first batch only.

### First-batch evidence

- Full local release gate (`oss-release-check.mjs --release-artifacts`) passed:
  251 infrastructure, 276 MCP, 3,084 portal and 1,613 shared tests, plus
  dependency/type checks, builds, docs validation and artifact preparation.
- Five isolated Playwright checks passed: card hit areas/contrast at 390, 768
  and 1280 pixels and preview-frame selection; screenshots inspected.
- Starter sync tests passed, and the current released 0.45.77 template still
  compares byte-for-byte. The new script family is not synced until MCP releases.
- Read-only hosted MCP probe with the adapted helper confirmed the configured
  Organization/Site and enumerated 48 Pages, 60 containers and 82 inventory URLs.
  No saved content, deployment, DNS or customer configuration changed.

## Expanded batch: explicit limits and acceptance

The follow-up implements the reusable P1 capabilities, not the source site's
custom converter, copy decisions, taxonomy or design. It retains explicit
Organization/Site/Version binding throughout. No change auto-publishes ulvon.

- Public REST discovery is bounded (30 requests by default, 50 maximum, 5,000
  URLs, 20 pages per REST type, 100 rows per page, 45-second discovery budget plus
  an in-flight request). UI crawls at most ten pages; API/MCP permit 0–50.
  Restricted types, historical redirects and orphan pages still need exports.
- Known solid-color contrast can be checked from block ancestry. Custom CSS,
  gradients, photo backgrounds and all responsive variants need visual review.
- Draft link checks help before publication, but do not count drafts as live.
- The structured progress field describes the exact queued task and attempt;
  counters are not an ETA or an overall progress percentage.
- Render reference changes restore declared spacing and hero/background behavior
  and add opt-in controls. Existing render-version fixtures are intentionally
  refreshed for these bug fixes; customer output changes only on normal rebuild.
- Preview frame links retain the signed ticket's expiry and opaque sandbox.
  Use the normal preview wrapper when testing extension host messages.

### Expanded-batch verification

- Full local release gate passed: 251 infrastructure, 278 MCP, 3,093 portal and
  1,619 shared tests, type checks, dependency audit, builds, static publication
  smoke scenarios, public documentation and release-artifact preparation.
- Final focused checks cover the HTML-parser-based discovery, solid-background
  warnings, actionable API envelopes and the progressive video facade. The
  facade keeps a normal source link without JavaScript and upgrades to a
  keyboard-operable player button when its runtime loads.
- 13 isolated browser checks pass, including actual site-template sanitization,
  widths 375/639/640/767/768/1279/1280, clickable/readable cards and no provider
  request before keyboard video activation. Desktop/mobile images inspected.
- The exact committed candidate still needs PR CI and authorized publication;
  local artifact files are not a production release receipt.
