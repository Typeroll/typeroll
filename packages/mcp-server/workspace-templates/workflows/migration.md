# Migration kickoff

If guidance is needed, start or resume workflows/interview.md. Otherwise fill in
this prompt from the confirmed brief. The two preservation choices are independent.

```text
Migrate [source URL] to Typeroll, Organization [ID/name], Site [ID/name], Version [ID].
Text: [preserve existing wording / renew against an agreed editorial brief].
Design and images: [preserve / renew against an agreed design brief].
Read AGENTS.md and use workflows/interview.md for missing decisions.
Read tr-migration-evidence, then tr-migrate-wp (or the appropriate source recipe).
Confirm the target and import readiness before writes. Inventory URLs, content,
media, templates and integrations; record both choices and exceptions in brief/migration.md.
Build and verify one prototype per distinct layout before bulk reconstruction.
Use standard blocks first, editable custom types next, isolated HTML only for
justified exceptions. Rebuild imported HTML with block tools; a mode switch does not convert it.
Keep preserved text unchanged even when the design is new. Record which images
may change. Preserve every old public URL or redirect to a relevant destination.
Protect existing CMS edits. Review text and design/images against their own
acceptance references, plus mobile/desktop behavior, downloads, forms and URL coverage.
Report unverified items separately. Do not publish, switch DNS or send messages
without explicit approval.
```

The managed importer stages cleaned HTML, media and shared references in Review.
The external agent can then reconstruct those Pages; no manual editor conversion
is required. An agent can also build block Pages directly from source material.
Neither path includes an automatic HTML-to-blocks converter. Read and preserve the
full source before switching modes, then save/read back and preview the rebuilt
Page on the selected Version. Never publish an empty intermediate block Page.

Track import, block reconstruction, separate text/design review, candidate
publication and domain cutover as separate milestones. Import completion is not
launch approval. All four text/design combinations use the same block hierarchy
and URL continuity contract. Planning choices are not migration API fields.

## Repeatable reconstruction and acceptance

Read workflows/design.md and scripts/README.md. First check whether public
WordPress REST + HTML covers the source; use tr-migrate-wp's access decision
table before asking for a helper plugin. Inventory both Pages and posts plus
internal links and known old slugs. A sitemap alone is not complete.

Discard HTML comments before extracting text, resolve relative links against
the source, and keep an explicit old URL map. Do not redirect deleted content
to the home page merely to get a 200. Preserve/renew text and design separately.
Use capture_text.cjs + compare_text.py for preserved text with explicit selectors.

Before every authorized test deployment run check_unsaved.py (Pages and partials).
Deploy saved content to the agreed protected test host, then run check_url_parity.py,
check_assets.py and shoot_hosted.cjs. Check whole-card targets with
card-stacking-check.cjs and inspect actual desktop/mobile screenshots. Record a
QA round and platform findings. Review on the owner's phone when possible.
Domain preparation/cutover and production indexing follow their own explicit
approval scope and the platform's current guided flow; do not bypass readiness.
Do not request a second approval for a step the owner has already authorized.


## Native controls and publication checks

On Core 0.2.103 / MCP 0.45.79 or later, discover the actual block schemas first.
Use column `content_gap_px`, responsive section `padding_y`, heading-role
`space_before`/`space_after`, hero focal/fit/text-position fields and image
`never_upscale` instead of one-off CSS. Responsive block keys start at `mobile`,
not `base`. For vertical-only spacing, do not reset horizontal padding with CSS
shorthand. Optional `click_to_load` videos need an explicit poster if desired;
choose a first-party poster to avoid early provider requests.

`import_sitemap` can include public WordPress REST (`include_wordpress: true`)
and a bounded crawl (`crawl_pages: 10`). Record truncation and access warnings.
A `matched_draft` URL is accounted for in the CMS but not ready for launch.
Resolve `unpublished_targets`, redirect loops/chains and actual deployed parity.

A deploy with working copies returns `unsaved_content`; review the targets.
Save explicitly or obtain approval to publish saved content only using
`allow_unsaved: true`. Never silently save somebody else's work.

Keep the bound Organization/Site/Version explicit. A site API key cannot switch
to another Organization: use an authorized OAuth connection or a separate key.
Read the schema for target envelopes and pagination; do not guess aliases.
Page/partial block writes update working copies; check `saved` and use
`commit_working_copy` with `target: {kind: "page"|"partial", id: "..."}`.
Page templates save immediately and do not have working copies. REST read envelopes and
MCP tool text are different layers; `call.py` returns the decoded tool result.

## Design token check

Follow workflows/design.md for palette/font roles and named scales. Run
`lint_design_tokens` before launch and after major design changes. Review exact
colour replacements with scripts/typeroll/color_tokens.py; record deliberate
exceptions in decisions.md. Preserve text independently from design changes.

## Source retirement, analytics and domain preparation

Before old hosting is retired, follow workflows/source-media.md: preserve unused
and print originals in a private archive with independently verified checksums.
Only approved web assets enter the CMS. Use ICC-aware conversion for CMYK/TIFF.

Enable Analytics through the authorized Typeroll API/MCP (`update_app` or the
Organization analytics tools), then read back settings and verify the beacon and
cookies on the actual artifact. Resolve missing provider scopes through the
normal approval flow. A separately authorized provider-side setup with a supplied
beacon token is an alternative, not a way to bypass Organization permissions.
Never expose a provider API token as a public beacon token.

Finish compiled test-host review before declaring future hosts when practical.
From Core 0.2.106, differing future hosts require explicit
`domain_candidate_revision` on `trigger_deploy`: this prepares saved content for
cutover; it does not update the old test/live host. Read `next_publication` in
`read_publishing_domains`. Use signed previews for ongoing review or a separate
Version for a new compiled test address. Do not repeatedly start an already
waiting job. `prepare_publishing_domain_change` moves the last successful public
snapshot, not later saved CMS changes. Review the frozen candidate's noindex
status: changing current settings cannot alter that candidate. If intentional
public indexing is required, save the approved indexing setting before preparing
the saved-content candidate. If the old candidate is still waiting, read the
current revision and re-save the same reviewed hosts to supersede it without
switching DNS; confirm the new revision for the new saved-content build.
Platform protection still keeps temporary hosts
noindex. Keep MX/SPF and unrelated DNS unchanged; review any validation window
and obtain the already-defined traffic-switch authorization.

## Owner-supplied facts and photos

Record owner statements, source and confirmation date. Preserve approved copy
under `text: preserve`; do not silently delete dates/prices or rewrite it into
"timeless" language. Under `text: renew`, propose removing stale details or using
recurring-event wording only when a source supports recurrence. Flag uncertain
facts for review or keep new Pages in draft; missing evidence does not prove that
an event stopped. Link to the actual organiser when relevant. Upload approved
photos with SHA-256 verification and review focal points at mobile/desktop widths.
