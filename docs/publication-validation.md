# Static publication validation — Core 0.2.22

Status: locally verified release candidate; not yet published to Cloud or a
customer site. Matching standalone MCP version: 0.45.20. Data schema stays at 2.

## Scope

Resolved-route BreadcrumbList through BaseLayout/SEOHead; independent noindex
and nofollow in static output and preview; safe direct schema mappings with
field errors for unsupported dotted/reserved properties; named separately
linked post-card images; trailing-slash policy in generated Page-source links;
accessible navigation toggle even when visual text is clipped. No customer
copy is rewritten and no customer site or DNS change is included.

The artifact validator runs after the frozen build has restored unchanged
HTML, written redirects/headers/sitemaps and included the media manifest.
Source locators are public `data-source-block-id` / `data-source-block-type`
attributes, separate from editor/runtime selectors. Heading ID extraction must
not mistake these attributes for `id`.

The trusted executor checks the report against the output file tree before
asset upload, and the coordinator checks publication, source/configuration and
transported artifact identity before completing the task. Failed validation
never reaches deployment activation. The portal and API/MCP return bounded
diagnostics. Readiness is configuration/export readiness, not a cached SEO pass.

## Evidence

Run `node scripts/oss-release-check.mjs`. The verified local run passed release
planning, dependency audit (existing temporary advisory approval unchanged),
docs checks/format, all workspace typechecks, 181 infrastructure tests, 5 docs
tests, 132 MCP tests, 2,077 portal tests, 546 shared tests, renderer sanitization
and every real Astro smoke scenario, frozen template packaging and full builds.
Typecheck has existing hints but zero errors. Browser diagnostics are separately
covered by two passing `publication-validation.spec.ts` tests at 375 and 1280
pixels; both layouts and the settings form were visually inspected. Final
validator regressions also cover whitespace around correctly named image links
and editorial warning locators for content blocks and metadata.

The final run exposed an existing media-storage test's asynchronous local queue
delivery leaking into its next fixture. That test now mocks the transport
boundary (separately tested); its assertion forbidding preview library scans is
unchanged. The focused storage/preparation/queue tests all pass.

Focused reproduction command, using only synthetic data and no external account:

```sh
TYPEROLL_SEO_PROOF_DIR=/tmp/typeroll-seo-release-proof \
  node --test scripts/publication-seo-build.test.mjs
node --test scripts/publication-validation.test.mjs
```

The first command uses `projectStaticPublication` → generated frozen project →
`scripts/build.mjs` → real Astro site-template. It temporarily reintroduces the
slug-only breadcrumb computation inside the frozen SEOHead component, proves
that publication fails, restores the implementation and proves it passes.
It also rejects legacy dotted mappings, checks both slash policies, public
noindex/follow, explicit nofollow, strict blocked versions, nested content-type
slugs, explicit paths, homepage and external canonical overrides.

Checked-in proof under `docs/release-proof/seo-0222/{always,never}/` contains:

- `regression-head.html`: real generated head with the deliberately reintroduced
  slug-only computation (`/abc` instead of `/companies/abc/`). It is a regression
  reproduction, not a claimed historical customer artifact.
- `corrected-head.html`: generated correct output, with one BreadcrumbList and
  the resolved root, Companies hub and company route.
- `regression-report.json` / `rejected-report.json`: source-located failures for
  the breadcrumb regression and unsupported address mapping.
- `accepted-report.json`: exact synthetic source/configuration/artifact hashes.
- `cache-proof.json`: all eight content routes reused on a warm build, all nine
  HTML files (including 404) checked; old cache format forces a full render;
  changing the validator version forces a full render and a fresh versioned report.

Additional tests cover malformed JSON-LD, named/wildcard redirect loops, missing
targets, image sitemap noindex, duplicate canonicals, inaccessible image links,
editorial constraints on unchanged pages, deliberate noindex links, external
canonicals, unlinked decorative images, filters and repeated contextual links.
Runner API tests reject missing/replayed/tampered reports and show that failed
validation leaves the saved live-site state untouched. Save API tests reject
unsupported schema maps before writes. Post-card tests cover standalone,
page-list and repeater instances, explicit/mapped/empty alt and missing titles.

## Release and migration

Publish the matched immutable Core template and MCP through the normal release
workflow only after approval. Pin its manifest in Cloud, qualify staging, then
promote that exact Cloud candidate after the production authorization. Drain
active old publications first: the new completion contract requires a proof.

Update each organization's Cloudflare or GitHub engine once via Publishing →
Builds. New admissions require `publication_validation: 1`; the setup action
installs the executor and runs its existing qualification. Engines without it
are shown as requiring an update. No extra provider permissions are introduced.

Normal publications use the new Core revision. Domain-only candidates retain
their old frozen renderer and must first receive a separately authorized normal
publication if that renderer predates the gate. This fails early with
`publication_renderer_update_required`, rather than changing frozen content.

Review legacy dotted schema maps before publication. Remove or replace unsupported
mappings while retaining content fields; do not substitute a city string for a
structured address or manufacture missing facts. Editorial constraints are
project settings (`seo_review`), not global keyword bans. Nothing in this change
automatically sets FundraiserChart's constraints or republishes FundraiserChart.

## Limits

The new gate covers customer-runner/frozen static publishing on both supported
build providers. Standalone Astro commands and legacy managed publishing do not
automatically run it. It is not a full Schema.org ontology or rich-results
validator, a semantic fact checker, external URL crawler or verified-bot test.
Only deterministic phrase constraints supplement editorial heuristics; human
review is still required for misleading promises. Dynamic client anchors and
fragment filters are allowed without claiming to execute every client workflow.
Redirect loop checks follow actual links and concrete/named/wildcard route
probes; they are not a proof over arbitrary provider-specific routing code.

Diagnostics have bounded examples and size. The complete error/warning counts
remain visible. Directory validation parses one HTML DOM at a time and streams
asset hashes; unchanged cached media is validated against existing receipts
without downloading image bodies again. These checks establish technical
correctness, not ranking or traffic gains.

## Sandbox download correction (Core 0.2.23 candidate)

The Core 0.2.22 staging engine qualification exposed an existing upstream
dependency failure: Ubuntu removed `bubblewrap_0.9.0-1ubuntu0.1_amd64.deb` from
its rolling archive (`404`). Core 0.2.23 uses the official Ubuntu snapshot dated
`20260918T000000Z` for both Cloudflare execution and GitHub sandbox bootstrap.
The binary, SHA-256 verification, download limit, redirect rejection, and sandbox
restrictions are unchanged. This is not a validator or data-schema change.

The corrected URL returned HTTP 200 and 50,178 bytes on 2026-09-19. Its SHA-256
was `1b506492bd9c7fd0cdb4f02ac822f1d3e336b0aead5113c1239baf8db5db562a`,
identical to the existing pin. The dated-archive regression failed against the
old URL and passed after correction, alongside the existing sandbox tests.
The full release gate also passed: dependency audit (existing temporary advisory
approval), documentation checks, typechecks, 181 infrastructure, 5 docs, 132 MCP,
2,078 portal and 546 shared tests, renderer smoke scenarios, frozen-template
packaging and all workspace builds. Hosted provider qualification remains pending.
The [Ubuntu snapshot service](https://snapshot.ubuntu.com/) retains dated
archives; it remains an external download dependency and can still be
unavailable. A failed or mismatched download continues to stop the build.

Existing organization engines must receive the corrected executor through normal
Publishing → Builds setup and qualification. Merely updating the portal does not
rewrite their repositories. Real provider qualification and the passing/failing
artifact staging checks must finish before Cloud production promotion.
