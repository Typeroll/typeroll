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
