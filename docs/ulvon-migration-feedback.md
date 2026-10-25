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
| F1 | P1 | Reported slot rhythm gap. Document flow/article wrapper now; add native slot rhythm with nested-layout regression coverage next. |
| F2 | P1 | Reported stored-but-ignored role spacing. Trace role emitter and add write/render parity; reject unsupported values if not renderable. |
| F3 | P1 | Actual-background contrast belongs in rendered QA, including current links. Do not validate a global part against white alone. |
| F4 | P2 | CSS shorthand intentionally sets all sides. Teach vertical-only changes; consider UI intent warning rather than silently changing CSS semantics. |
| F5 | Included | Recommend navigation_menu plus navigation_links slots; explicit drawer breakpoint and keyboard/boundary checks. |
| F6 | P2 | Text wordmark and light/dark logo variants need a block contract. SVG remains a valid documented asset, not a launch blocker. |
| F7 | P1 ops | Source reports API enabled manually. Reconcile Cloud infrastructure/health check separately; no production service changes here. |
| F8 | P1 | Return the exact property and authorized account instructions. Do not silently import a different GSC property on denied access. |
| F9 | P1 | Add public REST types/posts + crawl to inventory coverage. Starter now warns sitemap alone misses URLs; helper/export remains authoritative where available. |
| F10 | P1 | Organization/Site identity is critical. Helper checks binding now; investigate OAuth connection selection separately without broadening existing grants. |
| F11 | P2 | Normalize/document envelopes at a deliberate API boundary; do not break every consumer in a migration hotfix. Helper unwraps only known finalize envelope. |
| F12 | Included helper | Target the known signed preview iframe for QA. No arbitrary iframe selection or persisted browser session. A first-class direct-preview contract is future work. |
| F13 | Included initial tool | Explicit-region preserved-text diff. Automatic source-to-page matching and semantic/content completeness still require review. |
| F14 | Included | About column separate from link grid; inspect density and intermediate desktop widths. No universal pixel sizes. |
| F15 | P1 | Source confirms path-only navigation matching in renderer; add same-origin matching and external-root regression next. Do not deploy a footer workaround as a platform fix. |
| F16 | Fixed locally | Reproduced API success with dropped flag. PAGE_WC_FIELDS omitted append_seo_suffix; now stages/saves false/true/null. Existing preview/static renderers already honor false. API regression fails before fix. |
| F17 | P1 | Renderer already reads image_alt; schema/editor exposure and media-default behavior need alignment. Preserve decorative-image semantics. |
| F18 | P1 | Hero role color/part background needs actual rendered contrast review. No blanket plate rule or simplistic photo sampler. |
| F19 | Included | Public REST/HTML vs authenticated helper decision table; no unnecessary install. WordPress.org listing is separate review/publication work. |
| F20 | P2 | Document original/contain choices now; design never-upscale semantics across responsive image widths. |
| F21 | P1 | Hero focal point/aspect/text-position controls are reusable. Add native controls with mobile panorama fixtures next. |
| F22 | P0 fixed locally | Remove excerpt/meta opacity, isolate whole-card stacking and raise its stretched link; warn about incompatible secondary actions. Browser clicks/contrast at 390/768/1280; no customer CSS. Requires Core release + customer's normal rebuild before launch acceptance. |
| F23 | P1 | Click-to-load video facade is valuable privacy behavior. Lazy loading is not consent; poster/network/keyboard policy needs explicit design. |
| F24 | P1 | Add matched_draft/unpublished_target evidence without counting it as a deployed migration success. |
| F25 | Included | Parse and exclude HTML comments before text extraction/reconstruction. Text checker regression covers comments and scripts. Do not promise every server importer was changed. |
| F26 | Included | last_row:start is default; centering only on explicit owner request. No stretched peer to fill gaps. |
| F27 | P1 | Link extraction must use href/URL fields, not arbitrary style strings; distinguish unpublished from missing routes. Add regression fixtures next. |
| F28 | P1 | Separate attempt/progress, DNS propagation and verifier access failures. External starter checks supplement but do not repair platform verifier. Prior domain PR contains related work, not proof this case is resolved. |
| F29 | P1 | Responsive vertical padding + no silent type mismatch. Current shared type checks already warn select/map mismatch; verify hosted tool/runtime revision before claiming the report fixed. |
| F30 | P2 | Avoid new aliases everywhere until a versioned input contract is agreed. Document target and pagination now; clear errors can be independent fixes. |
| F31 | P1 + helper | Unsaved-copy gate included. Product should warn before deploy, never silently save another editor's drafts. Saved/working/deployed remain separate. |
| F32 | P1 + helper | Chain detection included in hosted parity check. Add write-time warning and migration report next; do not rewrite intentional redirects automatically. |

## Acceptance and release boundaries

Local synthetic tests cover the new helper's binding, pagination, redirect query/
cross-origin behavior, loops, assets and upload integrity; browser tests exercise
F22 using the shared renderer and real CSS. Text/working-copy tests cover F16/F25.
No tests here prove current ulvon production, search-engine access, or every source
adapter. Preserve the original migration evidence; recheck the actual candidate
site after the matching Core release and customer-authorized publication.

The prior guided-domain PR is separate. Coordinate artifact versions with that
pending release; do not assign two different sources the same Core/MCP version.

## Verification of this candidate

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
