# Changelog

## 0.3.28 (candidate, MCP 0.45.136)

- A build whose request to Typeroll or build storage timed out while it handed
  over the built site (`artifact_transfer_timeout`; engines before this release
  report `artifact_build_failed` with `TimeoutError: The operation was aborted
  due to timeout`) is run once more automatically, like a refused artifact
  upload. Other `artifact_build_failed` causes are not retried.
- A publication stores its frozen renderer before its source snapshot is saved.
  During a gradual Typeroll Cloud rollout the previous release could take the
  next step of a job the new release had frozen and failed it with
  `publication_internal_error` ("The original publication renderer is
  unavailable"). That case is now `publication_renderer_unavailable`, which the
  publication waits out and retries (up to five times) instead of failing.
- A build that build storage (R2) refused to accept at the end
  (`artifact_artifact_upload_failed`, typically HTTP 5xx during a short storage
  outage) is run once more automatically, on every build engine revision; its
  prepared media is reused and a second refusal fails the publication as
  before. Updated build engines also repeat the artifact upload up to three
  times within a few seconds, report what storage answered as the failure's
  cause, and name the reason on the optional `TYPEROLL_RENDER_CACHE` and
  `TYPEROLL_MEDIA_CACHE` "unavailable" log lines. The failure message says the
  live site is unchanged and to publish again; the code is documented in the
  customer publishing guide.
- A background image preparation that stopped under Core 0.2.149 or earlier
  no longer reports "Background image preparation stopped (unknown)" on every
  publication. `GET media/preparation` and the publication warning read the
  code from the build that stopped it (for example `build_queue_timeout` or
  `build_cancelled`), name its cause in `error` and `failed_build_task`, and
  say `media_preparation_cause_unrecorded` when that build never ended.
- `GET /api/v1/sites/{site}/publishing/impact` (MCP `get_publication_impact`)
  and each job's `build_impact` say when nothing was compared: `changes_known`
  is `false` and `baseline` gives `reason` (`not_published`,
  `publication_not_verified`, `snapshot_without_source_baseline`,
  `baseline_snapshot_unreadable`, `baseline_identity_mismatch`) and a message
  with what to do; `total` stays `0` for older clients. A domain change now
  records the source of the publication it republishes, with only its
  addresses replaced, so the next comparison has a baseline. Sites whose last
  publication was a domain change prepared by an earlier release are compared
  with the publication it was built from (reason
  `baseline_predates_domain_change`) instead of answering
  `verified_source_baseline_unavailable` until their next publication.
- `GET /api/v1/publishing/builds` (MCP `read_organization_build_engine`)
  reports `update_available` (now always a boolean) and `update_reason`
  (`engine_source_changed`, `capability_missing` or `null`) for every engine and
  the selected one, computed the same way a publication decides to update the
  engine. The Builds card shows **Build engine update available** for both
  reasons and, with automatic updates on, that the next publication installs it
  first.

## 0.3.27 (candidate, MCP 0.45.135)

- App contracts (Extension runtime 0.46.0, template capabilities 0.58.0) let
  official apps update without publishing sites. A manifest may declare
  `contract` (an integer) when its developer organization is listed in the new
  host setting `TYPEROLL_TRUSTED_APP_DEVELOPER_ORGS`; otherwise save and publish
  answer 403 `contract_developer_untrusted`, and contract releases stop running
  for an organization removed from the list. An installation stores its
  `contract` and always runs the newest published release of it; moving to
  another contract (including an app's first) is the only explicit activation,
  and `GET /extensions/self` returns `contract`. Every assertion and token
  Core signs for a contract installation carries a `contract` claim next to
  the resolved `version`. A release that removes a
  component or requires a new permission of its contract is refused with 409
  `contract_broken`; permissions may be `optional: true` and are then not
  granted on install.
- Components with `render_mode: "contract_component"` load `entry.module_url`
  (no hash, no vendoring) live in the browser, on published sites and in
  previews, and call `mount(element, { variant }, context)` with
  `context.variant`. Without `module_url` a component is static. Their blocks
  store a `variant` (default `standard`) and optional `reserve_px` instead of
  props; the mount carries `data-tr-extension-variant`, an optional
  `min-height` and no `data-block-data`, also for `<x-extension variant="…">`.
  The app lists variants through `variants` (`component_variants` assertion);
  `GET /api/v1/sites/{siteId}/extensions/{installationId}/variants` and MCP
  `list_extension_variants` return them, and the editor's variant field is a
  select fed by it.
- Each publication asks every contract app once for the default markup of all
  its mounts (`default_markup`, by component, variant and page language) and
  writes it, unfiltered, inside the mounts of the built pages, together with
  returned files under `/_assets/apps/…` (`{{asset:name}}` placeholders) and
  stylesheets linked before the site's CSS. When an app does not answer, the
  previous publication's markup, files and styles are reused, else the mounts
  stay empty; the publication records an `extension_default_markup_unavailable`
  warning and never fails on it. Apps without a contract behave as before.

## 0.3.26 (candidate, MCP 0.45.134)

- Transient storage errors from R2 (HTTP 5xx, `InternalError`, `SlowDown`,
  network errors) are retried up to three times with backoff instead of
  failing the request. On moveria.nl a publication failed with
  `media_coordinator_500` because R2 answered "internal connectivity issue"
  while the build's media grants were written. Conditional writes and
  streamed bodies are not repeated.

## 0.3.25 (candidate, MCP 0.45.134)

- The media transfer Worker in the customer's Cloudflare account hashes each
  file once, on the way into R2, and no longer downloads the stored copy to hash
  it a second time. It reads the source in 256 KiB pieces instead of passing
  every 4 KiB network chunk through JavaScript. A 4 MiB copy used about 24 ms of
  CPU in local workerd and now uses about 2 ms; on Workers Free (10 ms per
  request) Moveria's 3–6 MB images were stopped with error 1102 and 99 files
  were left uncopied. The integrity guarantee is unchanged: the hashed bytes
  are the uploaded bytes, the PUT has an exact length, and the digest and size
  are checked before a receipt is issued. The portal redeploys the Worker on
  its next use; older Workers keep working until then.
- A 503 from the transfer Worker without its own error code (Cloudflare
  stopping it at the plan's CPU limit) is now `media_transfer_resources_exceeded`.
  Typeroll retries it once after a pause and copies that organization's files
  one at a time until copies succeed again, instead of retrying three times at
  full concurrency. If it persists, the file's error says that the Workers plan
  stopped the copy and that Workers Paid raises the limit.
- Publishing checks once per publication, dry runs included, that every
  referenced media file is in the site's media storage. Files whose copy failed
  and was set aside (`migration_failed`), rejected imports and files with no
  stored copy fail the job with `media_missing`; `job.failure.missing_media`
  lists them (`media_id`, `filename`, `source_host`, `code`, `reason`; at most
  100) and `missing_media_total` counts them all. `POST
  /api/v1/sites/{siteId}/deploy` and MCP `trigger_deploy` accept
  `accept_missing_media: true` to publish without those files: their
  references are left empty and each one is reported in `job.warnings`. Files
  still uploading or migrating keep failing with `media_migration_pending`,
  which now gives their count.
- A media migration that set files aside no longer reports `complete`: the
  site and the overall status report `complete_with_failures`, and both carry
  `ok` (`true` only for `complete` without set-aside files), so a client that
  knows only `complete` can check `ok` or `failed_files`. `failed_media` now
  lists every set-aside file of every site, 100 per call with
  `failed_media_total` and a `failed_media_next` cursor (`failed_after` in
  `GET /publishing/media-migration` and `read_organization_media_migration`),
  with `source_host` and `source_url` without its query. Counts and the list are
  both read from the media records. Before, job counters (including that of an
  organization-wide pass from before per-site jobs) could report skipped files
  that `failed_media`, at most 50 per site and 100 in all, did not list: Moveria
  saw 99 skipped files and 12 listed. A copy of a stored file
  that fails for a passing reason (Workers plan CPU limit, 5xx, timeout) is
  retried after 1, 5, 15, 30 and 60 minutes like a pending import, instead of
  three times within seconds; only then is it set aside, marked
  `transient: true`. Refused sources and integrity failures are still set aside
  at once. Publishing → Media storage lists the files and offers a retry.

- The www counterpart of a site's website host now redirects to it by default:
  with `www.example.com` as the website host, `example.com` answers 301 (path
  and query kept), and the other way round. Before, the counterpart had to be
  added as a redirect host by hand; on autopilot.se nobody had, so the apex
  served the site directly, every app call from it got 403 (app backends allow
  only `https://www.autopilot.se`), and search engines saw duplicate content.
  Other subdomains get nothing implicit; a domain such as `example.co.uk` is
  paired through its Cloudflare zone.
- It is derived, not stored, so existing sites get it without a settings
  change. Reads add `www_redirect` (default `true`), `implicit_redirect_hosts`
  beside `redirect_hosts` in `desired` and `active` (omitted when empty), and
  `implicit_redirects` with `source: "default"`, `status` and any `issue`; the
  domain guide shows `www_redirect:<host>` and issues also appear as
  `host_checks` warnings. Save `www_redirect: false` to opt out (portal,
  `set_publishing_domains`, guide `save`); it changes no revision or approval,
  and the next publication or repair removes the host from Typeroll's rule.
- With automatic DNS, the next publication of a live site (also an unchanged
  one, without a rebuild) or `repair_previous_host_redirects` adds the
  counterpart to the website host's existing Single Redirect rule
  (`typeroll_previous_t_…`), journaled, idempotent and quota-checked, and never
  changes DNS. It does so only while the counterpart is proxied to the site's
  own Pages project or to `192.0.2.1`; a counterpart serving anything else is
  reported as `www_redirect_host_in_use` and left alone. With external DNS the
  301 is verified and otherwise reported with instructions. Every problem is a
  warning; a publication never fails because of it, and nothing is checked in
  the background.

- Changing an app installation's version no longer breaks the live site until
  the next publication. Each publication records the app versions it was built
  with (`extension_versions`), and `GET /extensions/self` returns
  `published_version`, so an app backend can keep serving the published pages
  until the next publication activates. Found on autopilot.se, whose event box
  failed for minutes after an app upgrade.

- A form that posts to an app endpoint the installed app version does not
  declare now fails publication with `form_app_endpoint_unavailable` and a
  message naming the form, path and version, instead of an unclassified
  internal error. Changing the installation to such a version is refused with
  `form_targets_undeclared` and `affected_forms` unless `confirm_form_targets:
  true` is sent.

- Render version 18: a Heading, Rich heading or Text block that opens the page
  has no space above its heading. Before, its 1.6em space collapsed through
  `<main>` and moved the whole page down.

- Frame previews (`frame_url`) no longer insert the "content changed" or
  derivation notices into the page, so they never shift the layout of a
  screenshot. The frame reports them in an `X-Typeroll-Preview-State` header
  and meta tags; the full preview shows them as an overlay.

- `typography` and `design_scales` in a settings update merge with the saved
  values, as colors and fonts already did. Before, `{ "typography": {
  "line_length": "none" } }` silently reset every other typography control.
  `null` resets one control, or all of them.

- Migration fetches from the old site honour `Retry-After` and back off on 429
  and 503, and sequential crawls pause briefly between requests. URL parity
  checks default to 4 parallel requests instead of 6.

- The site starter's check scripts run at a slow, polite pace on your own
  computer (2 at a time, 300 ms apart per host) and faster in cloud sessions
  and CI, retry 429 and 5xx with backoff, and say which pace they use
  (`TYPEROLL_REQUEST_PROFILE`, `TYPEROLL_REQUEST_CONCURRENCY`). Home internet
  providers can throttle or block many rapid requests. The docs, starter and
  skills now also say to dry-run before publishing, compare render upgrades
  against captures from before the upgrade, and check failed media before
  calling a migration done.

## 0.3.24 (candidate, MCP 0.45.133)

- A link to `#cookie-settings` now opens the cookie banner even after another
  script has made its href absolute, as long as it points at the same page
  (query and all). Before, the banner listened only for the literal
  `href="#cookie-settings"`, so on autopilot.se the footer link did nothing on
  a page where the attribution app adds tracking parameters to links. The
  banner also opens when the hash changes to `#cookie-settings`.

- Apps can send email with links that hide their address. `POST
  /delivery/email` takes `format: "linked_text"`: `[label](https://…)` in the
  text becomes a link in an HTML part that Core builds itself (everything else
  is escaped, so apps still cannot send their own HTML), and the plain-text
  part reads `label (url)`. A backslash escapes brackets. Without `format`
  nothing changes. Asked for by autopilot.se, whose event emails showed a long
  unsubscribe address.

- Published pages and the site preview no longer show an app component's
  editor placeholder ("Next occurrence loads on the published site.") to
  visitors. The text, always in English, showed until the Extension runtime
  replaced it, and for good when the script did not load. Pages with an
  Extension mount, as a block or an `<x-extension>` in a partial, now hide
  it with platform CSS, which also covers block types provisioned by
  existing installations. The mount takes no space until the component
  renders; what the component renders is unchanged. The editor canvas still
  shows the placeholder where the component sits. A bug fix of leaked editor
  UI, so it applies on every render version. Found on autopilot.se.

## 0.3.23 (candidate, MCP 0.45.132)

- The page list (`GET /api/v1/sites/{siteId}/pages`, MCP `list_pages`) reports
  `has_unsaved_changes` for every page, as reading one page already did. Before,
  the field was missing from the list, so a pre-publish check that read it as
  false missed drafts made with block edits. Found on moveria.nl.

- `cookie_consent.manage_button: "none"` leaves out the floating "Cookies"
  button (and its CSS) that reopens the banner; `"floating"`, the default,
  renders as before. Any link to `#cookie-settings`, such as a footer menu
  item, now opens the banner without custom attributes, as does a page opened
  at `#cookie-settings`; `check_internal_links` accepts the fragment. A
  settings write, and the publication's job `warnings`, report
  `cookie_reopen_link_missing` when the button is off and no partial or menu
  links to `#cookie-settings` or has a `data-tr-open-consent` element, since
  visitors must be able to withdraw consent as easily as they gave it. The
  portal's cookie settings have a "Reopen button" choice. Found on
  autopilot.se, where the floating button covered form options on mobile.

- Per-route block settings (`route_overrides`) now reach the published site.
  The publication projection carried every other block field but dropped this
  one, so a header block that is primary on the home page previewed correctly
  and published with its base settings on every route. Route overrides are
  projected like `responsive` data overrides (declared, rendered fields only),
  and a test now fails when a new Block field is neither projected nor
  declared editorial. Republish to apply. Found on moveria.nl.

## 0.3.22 (candidate, MCP 0.45.131)

- Organization owners can permanently delete an archived site themselves,
  through the API or an AI agent acting for them; until now only the platform
  operator could. `GET /api/v1/sites/{siteId}/deletion` (MCP
  `get_site_deletion_inventory`) writes nothing and returns document counts per
  collection and version, blockers (`not_archived`, `domain_serving`,
  `shared_with_other_orgs`, `media_present`, `hosting_service_unavailable`),
  the resources left untouched in the owner's own accounts (Git repository,
  the Pages project that keeps serving the last publication, DNS, app data) and
  a digest. `POST /api/v1/sites/{siteId}/deletion` (MCP `delete_site`) takes
  `confirm_site_id` and `confirm_digest` and refuses another site, a stale
  digest or a blocked site. It revokes the site's API keys, removes stale share
  index entries, deletes leaf first with the site document last, answers 202
  `in_progress` for a large site (repeat the same request), records an audit
  entry on the organization (`audit_id`) and retires a hosted site on its
  hosting service. Only an owner's personal connection may do this;
  administrators, organization and site API keys, shares and apps are refused
  with 403 `owner_authority_required`. A site whose deletion has started cannot
  be restored (409 `site_deletion_in_progress`). Guide: Delete a site.
- Datastores can list the documents beneath a path (`listTree`) on fixtures,
  SQLite and the Durable Object store.
- `core/embed` can wait for cookie consent: with `consent: "optional"` its
  HTML (iframes and images included) and `js` stay off until the visitor
  accepts all cookies in the banner, and a note with a button that opens the
  banner shows until then (`consent_placeholder`, otherwise a built-in
  sentence in the page language). Stored consent loads it at once; "necessary
  only" and "decline" keep it off. A write that gates an embed on a site
  without the banner returns `consent_embed_without_banner`. The default,
  `"none"`, renders as before. Found on moveria.nl, where an embedded energy
  comparer set its `v` and `vc` cookies before the visitor answered.

## 0.3.21 (candidate, MCP 0.45.130)

- Docs: render versions 16 and 17 in the settings table, styling the cookie
  banner, the version 16 `.form-actions` row, and what `tr-upgrade-rendering`
  checks for versions 16 and 17.
- Render version 17 also counts the font weights in the CSS of a site's own
  block types (`<style>` in the template, and `styles`), as its notes say for
  `<style>` elements in HTML. Found on autopilot.se, where a FAQ marker drawn
  at 400 in a layout block's template was not loaded without `fonts.load`.
- Archiving a site is no longer refused for its generated address
  (`site-….<sites domain>`); a live custom domain still blocks it.
- `typography.line_length: "none"`: prose fills its column.
- `route_overrides` on a block: settings per route kind (home, item, page,
  facet), for example a shared header section that is primary on the home page.
- Block writes refuse a new or changed select value outside its options with
  400 `invalid_field_value` (block, field, allowed values); a legacy value that
  is already stored stays editable and keeps its warning. Found on moveria-nl,
  where `level: 2` was saved and rendered as a `<div>`.
- A write that changes a published heading's generated id returns a
  `heading_anchor_changed` warning with the old and new id and how to keep it.
- `check_internal_links` checks `#fragment` and `/path#fragment` against the
  ids the target Page renders (`missing_fragment`); the migration launch report
  lists them as a non-blocking warning.
- Article JSON-LD `articleBody` (and FAQ answers) are plain text without
  `<style>`, `<script>` or markup.

## 0.3.20 (candidate, MCP 0.45.129)

- Site and page custom CSS accept `scroll-behavior` and `overscroll-behavior`.
  The check for the old Internet Explorer `behavior:` property also matched
  them, so `html{scroll-behavior:smooth}` was refused.
- Render version 17, found on autopilot.se:
  - Font weights and italics written in CSS count as in use: site and page
    custom CSS, block custom CSS, `<style>` elements and `style` attributes in
    HTML. Before, a weight used only there (a 600 menu) was not loaded and the
    browser drew a nearby or synthesized weight unless `fonts.load` listed it.
  - Bare element rules in site CSS (`h2`, `p`, `a`, `button`) no longer
    restyle the cookie banner; class rules such as `.tr-consent__title` still
    do. Its buttons use the body font at weight 600 instead of the browser's
    button font, because their `font` shorthand was invalid.
- The render version 16 notes say that a form's buttons sit in a
  `.form-actions` row, so CSS that placed the button in the form grid must
  target `form > .form-actions`.

## 0.3.19 (candidate, MCP 0.45.128)

- Media imports from a URL no longer lose files to passing transfer failures
  (found on moveria-de, where about 38% of 3–5 MB PNG imports answered 503
  `media_transfer_unavailable` but left an uncopied record behind):
  - `POST media/import` answers **202** once the media record exists and the
    copy failed for a passing reason, with `media_id`, `finalize: null` and
    `import: { state: 'pending', error_code, message, retry: { automatic: true,
    next_attempt_at, failed_attempts }, details }`. Successful imports report
    `import.state` `complete`. `GET media/{id}` (`read_media`) returns the same
    `import` state, so agents poll instead of importing again.
  - A refused source or file (4xx) is still an error and no longer leaves a
    new, empty media record behind; a pending record from an earlier import is
    kept as it was.
  - The Site's media migration retries a pending import after 1, 5, 15, 30 and
    60 minutes instead of three times in a row, and sets it aside only after
    the last attempt. The job stays `queued` until the next planned attempt.
  - Transfer Worker answers keep their own codes
    (`media_source_temporarily_unavailable`, `media_transfer_interrupted`,
    `media_transfer_timeout`, `media_transfer_busy`) instead of collapsing into
    `media_transfer_unavailable`, with the upstream HTTP status and Worker code
    in `details` and in the retry and failure logs. Error messages no longer
    tell an import to "retry the migration".
  - A Cloudflare 5xx error page (larger than a receipt) is retried like any
    other 5xx instead of failing at once as an invalid receipt, and 5xx/429
    answers lower the number of concurrent remote copies for a while.
  - A successful copy clears earlier `migration_failed` flags, and files already
    in organization storage are no longer counted as skipped in the migration
    status.
  - `upload_media_batch_from_urls` marks pending results `pending: true` and
    counts them in `pending`.
- A build that waits in the build provider's queue no longer fails the
  publication after 15 minutes (found on staging, where a static verification
  step waited behind the Organization's background media preparation and
  failed with `build_queue_timeout` when Cloudflare started it 15 minutes
  later):
  - A queued step does not expire while its provider build is pending. A
    provider build that stopped before anyone claimed the step is dispatched
    again, as before, within the existing attempt limit. Only a step that no
    runner claims within 6 hours (`QUEUED_BUILD_LIMIT_MS`, replacing
    `BUILD_QUEUE_WAIT_MS`) fails, with `build_queue_timeout` and a message
    saying the provider never started a runner for it.
  - A step's working time starts when a runner claims it: the claim moves the
    stored deadline by the time the step waited, so a long queue no longer
    shortens the build or a media window. The claim response keeps its shape;
    engines read only `deadline`, so older engines work unchanged.
  - The publication rechecks its own queued step (after 15 seconds, then
    every minute) until a runner claims it: it reads the step's provider
    build, records `provider_status`, starts a stopped one again and sets the
    job's phase, for example "waiting for Cloudflare to start the verification
    build (queued 6 min; this organization's background media preparation is
    running on the same build account)" or "waiting for 1 other build in this
    organization". The working phase returns once the step is claimed. A
    queued build or verification step no longer counts toward the 45-minute
    publication observation limit.
  - `build_progress.queue` in the deploy status (`get_deploy_status`) and
    `queue` on queued jobs in `GET /api/v1/publishing/builds`
    (`read_organization_build_engine`) report `state`
    (`waiting_for_provider` or `waiting_for_other_builds`), `message`,
    `queued_at`, `queued_for_seconds`, `provider`, `provider_status`,
    `provider_status_at`, `ahead`, `ahead_kinds`, `running_kinds` and
    `expires_at`. `build_progress.deadline` is null while the step is queued.
    The Publish menu and Publishing → Builds show the message.
  - `trigger_deploy`, `get_deploy_status` and `read_organization_build_engine`
    tell agents that a queued build is normal and must not be retriggered.

## 0.3.18 (candidate, MCP 0.45.127)

- Previews derive app data the way the next publication would. Core freezes
  the version's saved, published content with the publication projection
  (no drafts, working copies, pending proposals or private fields), calls the
  same app release with the same signed request and validates the result.
  Derived listings, counts and `{{site.derived_data_url}}` datasets for
  browser filters now work in preview. Results are reused only for identical
  frozen content, public app configuration and releases. A failed derivation
  shows a notice on every preview page instead of empty lists.
- `get_preview_link` reports what a link shows: `render_version`,
  `site_render_version`, `content_revision`, installed `apps` and the
  `derivation` receipt (`status`, `data_digest`, `receipts`, `cache_keys`,
  `skipped`, `error`). Links sign their content revision, and a preview page
  whose content changed afterwards says so, so render versions can be compared
  on identical content.
- Publications and dry runs record `derivation_receipt` on the deploy job, so a
  derivation can be verified with `trigger_deploy` `dry_run: true` without
  publishing or activating another app release.
- Render versions 14–16 fix found by comparing the Moveria sites: the webfont
  fallback stylesheet sits outside the cascade layers, so its `body` and
  `h1`–`h6` font rules overrode every layered font rule. A card title set to
  the body font rendered in the heading font. From 14 the stylesheet declares
  only the fallback faces; `--font-*` already carry the fallback.
- Font plans include the regular weight for text set in another role's font
  (for example tab labels in the heading font), which drew at the nearest
  planned weight and looked bolder.
- Preview fonts: Google font files are served by a hash of their full URL, so
  `l/font?kit=…` files load, and a file another portal instance's stylesheet
  named refetches the stylesheet once instead of answering 404.

## 0.3.17 (candidate, MCP 0.45.126)

- Render versions 14–16 fixes found by comparing the Moveria sites with
  versions 11–13. Each restores the intended output, so sites on 14–16 change
  where they were broken:
  - A grid, container or list with gap `none` keeps its columns. The gap was
    a unitless `0` inside `calc()`, which dropped the column rule and stacked
    the grid (all versions; visible from 14).
  - A block holding grid cells, columns, tab panels or another size container
    fills its container instead of shrinking to a few pixels in a centring or
    row container.
  - A list grid with fewer items than columns keeps one column per item
    instead of stretching one card across the row.
  - A list's pager keeps its distance from the items inside a container.
  - Button labels, step labels and table cells no longer hyphenate words that
    fit; breadcrumb and table-of-contents links wrap with the text again.
  - A plain section inside a container keeps padding chosen for it; only the
    automatic padding is removed.
  - A page that ends with a full-width container gets no extra space before
    the footer, like a page that ends with a section.
  - Render version 16 icon pairing pairs an icon with the next block, not
    with the icon's own instance style element.

## 0.3.8 (candidate, MCP 0.45.121)

- **Render version 14** is the default for new sites. Platform CSS is layered
  (`@layer`), so a site's own CSS wins without `!important`; every block gets
  responsive defaults; sites can set `content_widths` and `date_format`; and
  interface labels and dates follow the page language. Versions 1–13 render
  exactly as before. See [settings](packages/docs-site/src/content/docs/tools/settings.md#render-versions).
- **Motion and background media** (render version 14): `motion` entrance
  animation on sections, containers, lists and content blocks; background
  images and muted looping MP4/WebM videos on sections, containers and CTAs,
  with several sizes and a phone choice; text over images with gradients,
  translucent or glass panels, shaped plates and per-breakpoint positions. A
  site setting `motion: reduced` turns movement off. Runtimes ship only on
  pages that use them.
- **Story blocks:** `core/stats` (count-up figures), `core/timeline`,
  `core/audio`, `core/before_after`, `core/announcement_bar`,
  `core/scroll_steps`, `core/scroll_film` (scroll-driven frames or video with
  captions) and `core/svg_animation` (draw, sequence or reveal on enter, at a
  position, with scroll or in a loop). Galleries gain a lightbox and logo
  clouds a moving row. CSS variables, attributes and events let a site's own
  CSS and scripts hook in.
- The media library accepts MP4 and WebM up to 25 MB, filters by type, shows
  thumbnails and previews videos; the picker in the block editor does the same.
- From render version 14 a navigation link's minimum height includes its
  vertical padding (a one-line link is 44 px, not 60 px), so a heading above
  stacked links stays further from them than they are from each other.
- Restoring standard styles on a site below render version 14 writes the
  heading spacing that version had (1em before, 0.5em after), so the site's
  output does not change.

## 0.3.7 (candidate, MCP 0.45.120)

- Frozen publication snapshots are pruned at the end of each publication of
  the site: snapshots of publications that are no longer running, recent, among
  the three latest per version or referenced are removed, and the deploy
  record stays. See [customer-owned publishing](docs/customer-owned-publishing.md).
- Published sites get a home screen icon for iPhone and iPad and a 512 pixel
  manifest icon, generated from the favicon unless `apple_touch_icon` is set.
  Before, a site without a separately uploaded 180 pixel PNG showed a letter
  on the home screen. The portal has the same icon.
- The MCP server names itself "Typeroll CMS" and declares icons served by the
  portal, a white tile with a margin around the symbol, so connector lists such
  as Claude's no longer show the tightly cropped favicon. The portal also
  serves `/favicon.ico` and a web manifest.

## 0.3.6 (candidate, MCP 0.45.119)

- A new site can be published as it is: its seeded Home page is published,
  and the starter header and footer link only to it. Before, the first
  publication of a site created through the API or MCP failed validation,
  because the Home page was a draft and the starter links pointed to
  `/about`, `/contact` and `/team`, which a new site does not have.

## 0.3.5 (candidate, MCP 0.45.118)

- A test installation can set `MAIL_ALLOWED_RECIPIENT_DOMAINS` (comma-separated
  domains). Account and site mail then go only to recipients in those domains;
  others are removed, and a message with no allowed recipient is not sent.
  Withheld mail is logged without its recipients or links.
- Reconnecting Cloudflare keeps its build permissions while the organization
  builds on Cloudflare, also when the previous connection was an API token or
  its authorization was revoked, so publishing does not stop at the engine.

## 0.3.4 (candidate, MCP 0.45.118)

- **Typeroll-managed publishing is removed.** Core publishes every site through
  its organization's own GitHub and Cloudflare accounts. A site without a
  publishing mode, or with the former `managed` one, now uses customer
  publishing and needs its normal publishing setup like a new site; it is no
  longer refused with `managed_publishing_migration_required`. Sites migrated
  earlier keep publishing to their original Pages project.
- Site creation no longer provisions a Pages project or a fallback subdomain on
  the installation's Cloudflare account, and changing a site's slug no longer
  reprovisions one: `PATCH /api/v1/sites/{siteId}` no longer returns `dns_note`
  or `dns_warning`, and `urls.fallback` and `urls.staging` are null. The legacy
  custom-domain service on the installation's account is removed; the
  `/api/v1/sites/{siteId}/domain` routes answer `409` and point to
  `/api/v1/sites/{siteId}/publishing/domains`.
- The data import gives such sites `publishing_mode: "customer_git"` (the
  read-compare applies the same rule), and its report no longer has
  `managedSites`.
- The managed-site migration is removed: the MCP tools
  `check_managed_site_migration` and `migrate_managed_site_publishing`, the
  `/api/v1/sites/{siteId}/publishing/managed-migration` route and the site
  settings card.
- The remote E2E journeys that publish (`e2e:agent`, `e2e:fallback-indexing`)
  run on a site named by `TYPEROLL_E2E_JOURNEY_SITE` with a key in
  `TYPEROLL_E2E_JOURNEY_API_KEY`, since the persona fixture site no longer
  publishes. The indexing check finds the temporary address by origin.

## 0.3.3 (candidate, MCP 0.45.117)

- The hosted MCP server works on Workers. Its tools call the portal's REST API
  on the portal's own origin, which a Worker cannot fetch (Cloudflare answers
  522); those requests now run in process through the existing `SCHEDULER`
  self binding. No configuration changes.
- Remote E2E personas select their fixture organization after signing in, so
  a permanent target may give a persona other memberships.

## 0.3.2 (candidate, MCP 0.45.117)

- GitHub publishing works from the Workers runtime: requests to GitHub carry a
  `User-Agent`, which GitHub requires and Workers' fetch does not add.
- R2 media transfers work in the Workers build: it now applies the AWS SDK's
  browser file mappings, so the S3 client no longer mixes Node-only helpers
  into the browser build.
- A local Worker accepts a loopback `http://` portal origin by its address
  instead of by `NODE_ENV`.
- The remote target contract compares the expected digest with the served
  `bundle_digest`.

## 0.3.1 (candidate, MCP 0.45.117)

- Outbound calls from the portal and Forms Workers no longer fail before they
  are sent. Workers implements only `redirect: 'follow'` and `'manual'`, so
  Cloudflare and GitHub publishing, the OAuth token exchanges, SES
  notifications, Turnstile, Web Analytics and media transfers now ask for
  `manual` and refuse a redirect themselves, as before.
- `npm run e2e:target:check` compares the expected digest with the
  `bundle_digest` the target serves at `/api/version`.

## 0.3.0 (candidate, MCP 0.45.117)

- **Breaking for self-hosters: the Google Cloud profile and the Docker Compose
  fallback are removed.** Self-hosting now runs in your own Cloudflare account:
  `npm run self-host:cloudflare:plan` and `self-host:cloudflare:apply` install
  the released portal and Forms Worker bundle after verifying its digest and
  GitHub build provenance, create the R2 buckets in the EU jurisdiction and
  set secrets by name; `self-host:cloudflare:doctor` checks `/api/version` and
  `/api/readyz`; `self-host:cloudflare:backup` and `restore` export and
  restore the document store through the EU backups bucket. The
  `self-host:check`, `bootstrap`, `migrate`, `backup`, `restore` and
  `self-host:gcp:*` commands, `compose.yaml` and the Firestore runtime store
  are gone. See the [self-hosting guide](https://typeroll.com/docs/guides/self-hosting/).
- The document store has a TTL: a document with a top-level `delete_at` is
  removed by the alarm of the store object that holds it once that time has
  passed. Form submission retention, rate-limit counters, expired sessions and
  verification tokens, and MCP authorization codes and refresh-use markers use
  it; no scheduled job looks for expired records.
- `/api/readyz` reports `datastore_runtime` instead of `firebase_admin`: a
  deployed installation must run on the Durable Object store in the EU
  jurisdiction. A new installation records its data schema in its empty store
  (`TYPEROLL_STORE_BOOTSTRAP=empty`); a store with data but no schema record is
  never adopted and the portal answers 503 until it is restored or migrated.

## 0.2.157 (candidate, MCP 0.45.116)

- Publication cache recovery stays on the site's own addresses. A stale file
  gets at most three refreshes of its one path per publication, then the job
  reports which layer is stale (`cache_recovery.layer`: `upstream_cache`,
  `origin` or `unknown`) with the Cloudflare ray. The zone-wide cache refresh is
  retired: it could not clear Cloudflare Pages' own URL-keyed cache and it
  cleared every other site in the zone.
- A removed file whose name carries its content hash passes verification when
  Cloudflare still serves exactly those bytes and a fresh cache key shows the
  deployment no longer has it. It is reported in `retained_immutable` and
  `warnings`. Previously such a file failed test-address publications for good,
  because Pages only invalidates a custom hostname's cache on production
  deployments.

## 0.2.156 (candidate, MCP 0.45.115)

- A link style's `visited` colour now reaches published sites. The publication
  projection copied `hover` but dropped `visited`, so the `:visited` rule from
  0.2.153 appeared in previews but never in published CSS. A test now fails when
  a stored style field is missing from the publication.
- A publication that stops with `publication_internal_error` now logs the
  error's name, message and a short stack (signed URL queries and bearer tokens
  removed), so the cause can be found from the job ID.
- The organization build engine can keep itself current. With **Keep the build
  engine updated automatically** on the Builds card (MCP
  `set_organization_build_auto_update`), a publication that finds an outdated
  Cloudflare or GitHub engine installs the new one and runs its verification
  build before building the site. If verification fails, the previous engine is
  restored and the publication continues on it. A build that fails in a way the
  newer engine is known to fix, such as a sandbox mount the provider stopped
  allowing, is updated and built once more from the same frozen source. Each
  publication reports what it did in `engine_update`. On for organizations whose
  first engine is set up from this release; existing organizations opt in.
- A failed engine update, manual or automatic, now restores the previous ready
  engine instead of leaving the organization unable to publish.
- Build engines probe each sandbox mount a host may refuse (`/proc`, `/dev`,
  `/tmp`) and fall back to an isolated alternative for that mount only, so a
  provider change of that kind no longer stops builds.
- An unexpected error behind a publishing or build-runner HTTP 502 is now
  logged as a `publishing_connection_failed` event with its error name, code,
  provider status and a short stack, with signed URL queries and bearer tokens
  removed. Build-runner entries name the organization and action. Previously a
  failed runner claim returned a generic 502 and left no trace of its cause.

## 0.2.155 (candidate)

- Connecting an AI client takes one step. **Account → AI connections** has
  **Add to Claude**, **Add to Cursor** and **Add to VS Code**, which open the
  client with Typeroll's MCP address filled in (the person confirms there and
  signs in), and one copyable command each for Claude Code and Codex. Claude's
  link is Anthropic's documented prefill for the Add custom connector dialog,
  with an organization variant for Team and Enterprise owners. Every link uses
  the portal's own address, so self-hosted portals get theirs. The docs start
  with the same table.

## 0.2.154 (candidate)

- Cloudflare build engines work again. Around 20:00 UTC on November 4, 2026,
  Cloudflare's build hosts started refusing the private `/proc` that the
  engine's sandbox mounts (`bwrap: Can't mount proc on /newroot/proc`), so
  every Cloudflare build failed while installing dependencies. Updated engines
  keep the private `/proc` where the host allows it and otherwise build
  without one; they never bind the host's `/proc`, which would expose the
  supervisor's environment to build code. The build check accepts a sandbox
  without `/proc` once it sees no other processes. Engines from before this
  release cannot be fixed centrally: their failures now say to update the build
  engine instead of reporting a dependency error.
- Large publications reach GitHub again. GitHub's App rejected a tree carrying
  an 11 MB inline `publication.json` with 422 `GitRPC::BadObjectState` while
  accepting the same tree from a user (fundraiserchart.com test version).
  Derived app data and the impact snapshot now live in their own files under
  `content/` (size-bounded parts, with source and key order kept, so the
  derived data URL is unchanged), and files of 256 kB or more are stored as Git
  blobs before the tree is created. For FundraiserChart `publication.json`
  shrinks from 11.1 MB to 2.3 MB and the tree request from 12.4 MB to 0.9 MB;
  unchanged derived parts reuse their blobs.

## 0.2.153 (candidate)

- A media host is reported live only after it serves the publication's files.
  On fundraiserchart.com a domain preparation reported `media.fundraiserchart.com`
  as live although neither its DNS record nor its R2 custom domain existed: an
  earlier Core marked a publication's media as prepared before preparing it, and
  a resumed job trusted that flag. Publications now record a receipt naming the
  exact hosts, namespace and files that were proven, and only that receipt
  counts. Cloudflare must report the R2 custom domain and its certificate as
  active, and every image, earlier image address and share copy must answer
  over HTTPS with its exact bytes. Until then the job stays in
  `distributing media` and `media_delivery` names what remains: missing DNS, a
  pending certificate, a rewrite rule for another namespace, a missing file or
  different bytes. The domain guide shows the same check. Retrying after a
  partial failure adds only what is missing and leaves a working custom domain
  and rule as they are. Verification retries never provision; they only check.
- Share copies (og:image) of images served from a separate media host are
  stored on that host through the ordinary media stage, next to the image in
  the site's R2 namespace, instead of in the Pages deployment. Their names come
  from the source image and the copy recipe, with a receipt, so an unchanged
  copy is reused and never rendered again. The publication checks that the
  media host serves them before it replaces the live site; a copy that cannot
  be stored fails the build and keeps the previous publication live. Pages that
  shared a copy at `/_assets/share/` keep that address working through a 301 to
  the new copy (within Cloudflare's 2000-redirect limit; beyond it the page
  keeps its website copy). Sites without a separate media host keep their
  copies at `/_assets/share/` as before. Older build engines need no update.
- The first image on a page asks for the full viewport width (`sizes="100vw"`)
  when no layout estimate applies. It loads eagerly and cannot use `auto`, so
  the generic "800px" made a full-width first image soft on wide retina
  screens. It now gets a variant matching the screen width and density, at the
  cost of a few extra kB for that one image.
- Lazy images that carry a layout estimate (grid cards, columns) now also get
  `auto` on their sources. Before, only images without an estimate did, so
  cards never used their rendered width (found on moveria.se).
- A version's test address points at the branch alias Cloudflare Pages actually
  serves. Cloudflare shortens branch names to 28 characters, so a long version
  such as `seo-sharing-render-refresh-2026-11-04` was served on
  `version-seo-sharing-render-r.<project>.pages.dev` while Typeroll pointed the
  test address at the full name and it answered 404. The alias comes from the
  deployment Cloudflare returned, with Cloudflare's own rule as the fallback.
  A test-address record Typeroll created against the wrong alias is corrected
  on the next publication; records Typeroll did not create, and live websites,
  are never rewritten.
- A version whose branch would exceed Cloudflare's 28-character alias keeps its
  first characters and ends in a short hash of its full name, for example
  `version-seo-sharing-r-3bcd58`. Two versions can never share a test address,
  and short version names keep their branch.
- When Cloudflare has activated a version's test address but it still does not
  serve a build that answers on its branch alias 10 minutes after the build was
  verified, the publication stops with `test_address_unreachable`, naming the
  alias to point it at, instead of waiting 45 minutes.
- Fixes from the Moveria market sites:
  - `create_redirect`, `upsert_redirects` and redirect edits refuse a rule
    whose target is the same page in another slash form or letter case, also
    as an absolute URL on the site's own host, with code `redirect_self`
    (AT-07). Every refusal now has a stable `code` (`redirect_self`,
    `redirect_loop`, `redirect_hides_page`, `invalid_redirect`), and warnings
    name only chains the new rule takes part in.
  - Redirects that end on a website media path (`/wp-content/…` →
    `/media/…`) are published straight to the file on the media host, so an
    old file address answers with one 301 instead of two (AT-08).
  - A site-wide share image (`default_og_image`, logo) gets `og:image:alt` from
    its media library alt text, never from the first image in the page body
    (AT-10).
  - Two media records with the same bytes and public path are published once,
    with both references pointing at it, instead of stopping publication with
    `media_path_collision` (AT-14).
  - A GitHub 422 when creating the publication tree is retried twice, the last
    time without reusing blobs (AT-18).
  - The link style role accepts `visited` (a colour), emitted as `:visited`
    for links in text and prose (SE-04).
  - `create_zone` refused by Cloudflare answers `zone_create_permission_required`
    with the permission and the dashboard fallback (SE-06).
  - `check_site_indexing` reports a pending or deactivated Pages custom domain
    on the live host as an issue with `matches_expected: false` (CH-07).
  - A media migration whose only leftovers are unfetchable sources ends
    `complete` with them in `failed_media`; a retry restarts those sites too
    (FI-10).
  - A publication says when the site's background image preparation stopped,
    in `job.warnings` and `job.media_preparation`; build activity splits
    `attempt` into `media_continuations` and `retries` (SE-07).
  - `analytics_site_limit` says who must act (the account's administrator or
    the installation's operator) and is documented (ES-02).
  - `POST /v1/sites` also returns the new site's `id` at the top level (BE-02).
- The site logo keeps its full-resolution variant: the display-height `sizes`
  from #160 is withdrawn, since it saved about 0.2 kB per logo and sharpness on
  high-density screens matters more.

## 0.2.152 (candidate)

- Fixes for the image changes in 0.2.151, found on moveria.se:
  - Share copies (SE-10) were never made on customer build engines: the build's
    media stage reads a publication without its pages, so it could not tell
    which images pages share. The portal now marks those entries
    (`share_source`) in the media manifest. This also lets SVG share images on
    a separate media host get their PNG copy.
  - Art-directed images (SE-11) were not expanded once the page body had
    passed the HTML parser, which writes `<source></source>` and escapes `<`.
    Both forms are now recognised.
  - Cards in a `core/grid` get a `sizes` from its columns too (SE-09).
  - Only the first visual image on a page loads eagerly with high priority.
  - Image sizing no longer depends on knowing each block type. Lazy images get
    `sizes="auto, …"` on their sources, so browsers that support it use the width the image is
    actually rendered at, in any core or custom block type. The layout
    estimate after `auto` is the fallback; any container block type with a
    `cols` or `columns` field gives its children one. Header and footer
    partials now get variants, dimensions and sizes too, without taking the
    page's leading image slot. `auto` is set only on the generated
    `<source>` elements of a lazy image with known width and height, never on
    the `<img>`, which browsers would otherwise give a 300×150 placeholder size.
- Once a publication is done, Typeroll reads the home page once and requests
  the images it references (og:image, each `<img>`, the first `srcset`
  candidate) on every host they use. When one does not answer 200, the job
  shows `images not served` with the first failing address (`media_check`).
  Nothing is scheduled; server errors and timeouts report nothing.
- A new media host is attached and serving its files before a publication
  replaces the live site. Engine publications marked media as prepared as soon
  as Cloudflare returned a deployment, so a domain preparation that added a site
  media host published pages pointing at a host that was not attached yet, and
  their images failed until it was set up.

## 0.2.151 (candidate)

- MCP connections no longer expire. A connection made by signing in lasts until
  it is revoked in Account → AI connections, or until the person loses access;
  the 30-day limit is gone. Refresh tokens are single-use and have no practical
  expiry; one chain head per connection and client detects a replayed token and
  revokes the connection. When a grant does end, the token error says whether it
  was revoked or replayed and how to reconnect.
- A site can serve its images from its own media host, such as
  `media.<site domain>`, so image addresses do not show the organization's
  domain. The host serves the organization's public R2 bucket through a path
  rule, like the shared host, and the Pages deployment carries only pages.
  Images that earlier publications served from the website under `/media`, or
  from the shared host, keep working: `/media/*` redirects to the site media
  host. The portal suggests `media.<site domain>`.
- Site admins can turn on Cloudflare Turnstile for a site's forms in the portal,
  under Forms → Spam protection: paste the widget's site and secret keys, see
  which forms require the check, or turn it off. A new guide, Stop form spam
  with Turnstile, covers the portal, the API and AI agents.
- REST API parity with MCP is documented and enforced. A generated REST API
  reference lists the REST call behind every MCP tool, with its parameters and
  required permission; CI fails when a tool and the page disagree, and every
  tool must call the REST API. A new guide, Use the REST API, covers
  credentials, several organizations and errors.
- Personal API tokens: create one in Account → AI connections for scripts. It
  has your access in every organization (name one per request with the
  `Typeroll-Organization` header) and is shown once. A token can be limited to
  some organizations, made read only or set to expire; at most 20 are active.
  The list shows when each was last used.
- Writes through personal connections and tokens are audited with the person's
  user id, and organization routes are audited on the organization. Discovery
  (`GET /api/v1/organizations`, `/api/v1/sites`) ignores the organization header.
- Images in multi-column layouts load a fitting variant. Repeater items in a
  grid, masonry, carousel or justified layout, and blocks in either side of
  `core/columns`, get a `sizes` that matches their column width until the layout
  stacks, and a `core/image` with a maximum width never asks for more. An image
  that already sets `sizes` keeps it. Before, every image used the generic
  "(max-width: 768px) 100vw, 800px", so a 300 px card loaded a 1024 px variant.
- A `core/image` with a mobile image gets AVIF and WebP variants for both
  images: the mobile sources under its media query, then the desktop sources,
  each with its own `sizes`, with the originals kept as fallbacks. Before, this
  art-directed `<picture>` served only the original files.
- Only the first visual image on a page, and a second one close to it, load
  eagerly with high priority. An image far below the first, such as a banner
  after a short article, stays lazy.
- Large share images are no longer shared as the uploaded original. When a
  page's og:image is a JPEG, PNG or WebP over 300 kB or wider than 1200 px, the
  build makes a JPEG copy at most 1200 px wide (aspect ratio kept, never
  upscaled, under about 300 kB) from the image's own prepared WebP variant, and
  points og:image, og:image:width/height and twitter:image at it. Smaller share
  images stay as they are, and the page's srcset still offers every large
  variant. The copy travels with the publication; no build engine update is
  needed.

## 0.2.150 (candidate)

- Background image preparation no longer stops for good when its build waits
  behind a long publication. The build kept the 15-minute queue limit meant for
  someone waiting on a publication, failed with `build_queue_timeout`, and the
  job reported only "Image preparation stopped". Preparation builds now wait
  until their six-hour deadline. Passing stops (an engine update, a runner
  Cloudflare did not start, a lost lease, a step time limit, an interrupted
  transfer) start a new round after 5 minutes, doubling up to an hour, and never
  end the job. `get_media_preparation` reports `retry` and `error_code`. A job
  that does fail names its cause, code and `failed_build_task`.
- `build_progress` separates planned media windows from retries. Large media
  sets are prepared in windows of about 12 minutes, so `attempt` rises in a
  healthy build. `media_continuations`, `retries`, `attempt_limit` and
  `deadline` now say which is which, and the portal shows "part N" instead of
  "attempt N".
- Static output on customer Cloudflare engines has no total size cap. The
  512 MiB limit was Typeroll's own; Cloudflare Pages limits only 20,000 files
  and 25 MiB per file. The engine uploads large outputs in runs of at most
  256 MiB and 4,000 files, each with a fresh upload grant and time limit, and
  deploys once. A build that exceeds a limit logs `TYPEROLL_OUTPUT_LIMIT` with
  the limit, totals, largest files and largest folders. Organization build
  engines must be updated to use chunked uploads.
- Cloudflare Turnstile for site forms, against spam from bots that fill in
  forms in a real browser. `set_form_spam_protection` stores a Turnstile
  widget's site key and encrypted secret (checked with Cloudflare); published
  forms render the widget and send its answer with the first step. Each form
  requires Turnstile once its republished pages send a verified answer, so
  earlier pages keep working until then. The forms runtime is version 3.
- Images are served from the organization's shared media host by default. When
  the organization has one and the site has no media host of its own, the build
  engine writes images directly to the customer's public R2 bucket and the Pages
  deployment carries only pages, so large media libraries no longer hit Pages
  file limits or slow every publication. Images that earlier publications served
  from the website under `/media` move there on the next publication, and one
  `/media/*` 301 redirect keeps their old addresses working. Publication
  verification treats redirected media paths as moved. Site icons on a separate
  media host are read locally for the favicon files only.

## 0.2.149 (candidate)

- A published form on the customer's domain can load its live choices again.
  The CSRF origin check rejected `/api/forms/options` from any origin outside
  the portal allowlist. It is now exempt like `/api/forms/submit`, which it
  matches in protection: the same signed form token, a per-IP rate limit and
  read-only public choices.

## 0.2.148 (candidate)

- Customer-engine publications now keep which form fields load live choices.
  Core 0.2.146 added them to the public runtime, but the static publication
  projection, which allowlists form fields, still dropped `option_sources`, so
  published forms kept their placeholder option. Only field names are kept,
  validated and limited to 20.

## 0.2.147 (candidate)

- Publication verification no longer requires a retired self-hosted theme font
  (`/_typeroll/fonts/<content hash>.woff2`) to disappear from the public host.
  When Google Fonts serves new bytes for a family, the next publication gets a
  new font file. The old file, named by its own hash and no longer referenced,
  could stay in Cloudflare's edge cache, so the publication failed with
  `publication_cache_refresh_required` and asked for a zone-wide cache refresh.
  The exact candidate still checks the file's absence, as for retired script
  and style bundles.

## 0.2.146 (candidate)

- Published forms now load live choices from an installed App's option source,
  such as Recurring Events' open occurrences. The publication's form snapshot
  dropped `option_sources`, so the rendered form was not marked for live
  choices and kept its placeholder option (for example "Loading dates…").
  Only the field names are published; the source configuration stays in Core,
  which reads it when the browser asks `/api/forms/options`. The renderer
  already supported this, so no build engine update is needed.

## 0.2.145 / MCP 0.45.109 (candidate)

- A media retry on the build engine now waits its own 15-minute queue window.
  It used to keep the first attempt's queue time, so a retry after a slow
  provider queue expired within minutes and the job reported
  `build_queue_timeout` instead of the real failure. When a retry does time out
  in the queue, the message now names the earlier attempt's cause.
- Background image preparation skips a library image whose stored file does not
  decode, such as a truncated PNG, instead of failing every image in the Site.
  The file is recorded as unreadable for those exact bytes and listed in
  `get_media_preparation` as `unreadable_media`; uploading a working copy
  prepares it again. Storage and timeout failures still stop the job.

## 0.2.144 / MCP 0.45.108 (candidate)

- `{{site.current_year}}` in text and prose blocks, custom block templates and
  HTML content (Pages, Page templates, header and footer partials) renders the
  current UTC year as plain text, e.g. `© 2020–{{site.current_year}} Example`.
  A publication captures the year once at build start, so every page shows the
  same year; preview uses the current year. The source keeps the variable. A
  published site changes year on its next publication, not at midnight; the
  render cache includes the year, so that publication re-renders every page.
  The renderer travels with the frozen publication, so no build engine update
  is needed. Only this reserved variable expands in authored HTML; other
  `{{...}}` text is left as it is.

## 0.2.143 / MCP 0.45.107 (candidate)

- `core/prose` (Text) and `core/text` (Text line) take an optional `color`
  (**Text color**), the same field as `core/heading`'s: a palette token such
  as `on_secondary`, a palette CSS variable or an explicit CSS colour. It is
  written on the block element (`color:var(--color-on-secondary)`), so a label
  in a header or menu partial, such as "Get a quote:" on a secondary panel, can
  be a paragraph with its own size, weight and colour instead of a heading
  that comes before every Page's H1. Without the field the markup and CSS are
  unchanged, so no render version is needed. Invalid values warn at write and
  render nothing; `lint_design_tokens` reports explicit colours as it does for
  headings.

## 0.2.142 / MCP 0.45.106 (candidate)

- Long workflow runs finish instead of stopping mid-way. A run no longer
  executes as background work of the request that started it, which Cloud Run
  starves of CPU and recycles (`url_parity` on an 810-URL inventory stopped at
  724/810 and 809/810). It runs in short chunks of at most about 45 seconds of
  new work, each delivered through the scheduled-work queue (Cloud Tasks to
  the existing worker route; the self-host worker or process timers without
  Cloud Tasks). `url_parity`, `link_check`, `performance_audit` and the
  migration import save their progress and the results gathered so far after
  every chunk and continue from there, so a restart only delays a run and no
  URL is checked twice. Every chunk commits with a compare-and-update on its
  id, so a duplicate delivery does nothing, and a cancelled run stops at the
  next chunk. A read that finds a running run without a heartbeat for 3
  minutes resumes it from its saved progress, up to 3 times; only then is it
  closed as `failed`/`workflow_interrupted`. The API, MCP and status contract
  are unchanged.
- Preview links: the browser's Back button returns to the previous preview
  page. A click inside the preview added a second, frame-only history entry,
  so Back first went back inside the frame and left the address on the newer
  page. The preview frame now moves in place and each page is one entry.
- Publishing to a site's temporary address ends at cutover. Once a site serves
  its live custom domain, the same publication serves the live domain and the
  old temporary address, so every deploy is a production release. A deploy
  of such a site that is not a dry run now needs an explicit acknowledgement:
  **MCP clients and API callers publishing a cut-over site must pass
  `confirm_live_domains: true`** to `trigger_deploy` / `POST /deploy` (and in
  the config of a production `rebuild_deploy` workflow), only after the site
  owner approved the release. Without it the request returns
  `409 live_domain_confirmation_required`, naming the live URL, with
  `live_domains`, `targets` and `production: true`. Sites that are not cut over,
  dry runs, `get_preview_link` (including `include_working_copy`),
  `get_publication_impact` and verification retries are unchanged.
- `get_publication_impact`, every deploy result and the deploy job report
  where a publication lands: `production`, `live_domains` and `targets` (live
  domains first, then the temporary address).
- In the portal, the Publish confirmation names the live domains of a cut-over
  site, and the publishing menu notes that a deploy publishes to them.
- The migration recipes (`tr-migrate-wp`, `tr-migrate-multisite`), `tr-edit-site`,
  the `trigger_deploy` description and the docs say to review a live site with
  `get_preview_link` (`include_working_copy`) and to treat every deploy after
  cutover as a production release that needs the owner's approval.

## 0.2.141 / MCP 0.45.105 (candidate)

- A domain switch goes live only when Cloudflare reports the website host's
  Pages custom domain as `active`. While it is pending or deactivated, Typeroll
  asks Cloudflare to retry validation once the record points at the Pages
  project; a domain that is blocked or not active by the deadline fails the
  switch with `pages_domain_not_active` and restores automatic DNS. Previously a
  host still answered by a previous provider could be marked live while Pages
  had no active binding.
- Serving checks read the Pages custom domain too, continue daily after the
  first 30 minutes, and retry validation for a pending or deactivated domain
  (at most once per check and every five minutes). A domain that is not active
  shows `pages_domain_not_active` with the remedy, `next_action`
  `retry_validation` and the job phase `Pages custom domain not active`. Sites
  that went live earlier get these checks on their next domain read.
- `guide_publishing_domain_change` takes `action: "retry_validation"` (and
  Publishing shows **Retry validation**): an idempotent re-check of the live
  host that asks Cloudflare to retry Pages validation, never a DNS change.
- Before a switch, a website host still answered by a Cloudflare for SaaS host
  such as Kinsta shows the warning `previous_host_saas_hostname`: remove the
  domain there right before or right after approving, inside the validation
  window.
- Preview links: a link to another site, or to a portal page outside the
  preview, opens in a new tab instead of a browser error page inside the
  preview frame. The preview stays on its page; in-site, `#hash`, `mailto:`
  and `tel:` links, links with a `target` or `download`, and modifier-clicks
  behave as before. Published sites are unchanged.
- Workflow runs stopped by a portal restart no longer report `running` for
  ever. Runs record `heartbeat_at` on every step write and about every 30
  seconds during a long step; a read (`get_workflow`, `list_workflows`, the
  API or the portal) closes a run that has been `running` without a heartbeat
  for over 10 minutes as `failed` with `failure_code: "workflow_interrupted"`,
  conditionally, so a live or completing run wins. New `cancelled` status:
  `cancel_workflow` (MCP), `POST /api/v1/sites/{site}/workflows/{id}/cancel`
  and a Cancel button on the run page stop a pending, running or paused run,
  with the permission starting its type needs.
- `core/container` takes an optional `lang` (**Language of this part**), a BCP
  47 tag checked like language sections (`fr-BE`, `zh-Hant-TW`). It renders as
  `lang` on the container's element in published HTML and preview, so every
  heading, text, button and image alt inside is read in that language, such as
  a French column on a Dutch page. A right-to-left part also gets `dir="rtl"`,
  and a left-to-right part on a right-to-left page `dir="ltr"`; an authored
  `dir` attribute is kept. An invalid tag is rejected at write. Without the
  field the output is unchanged, so no render version is needed.
- `POST /api/v1/sites` (`create_site`) saves `language` at creation, in the
  site and in its settings, so `<html lang>` is right from the first build; it
  is checked like `update_site`'s and defaults to `en`. It also takes an
  optional `id`, used exactly (409 `site_id_taken` when taken) instead of the
  id derived from `name`. Unknown fields answer 400 `unknown_field` naming
  them instead of being dropped. `create-and-migrate` and `create-and-plan`
  (`create_site_and_migrate`, `create_site_and_plan`) accept the same `id`
  and `language` and refuse unknown fields the same way; MCP already refused
  unknown arguments. Responses include the site's `language`, and the docs
  list every accepted field.
- Previous website addresses no longer cost one Single Redirect rule each in
  their shared hosting zone: one `typeroll_previous_t_…` rule per new website
  host lists every previous address of that site. Older per-host rules keep
  working, are extended in place and, after go-live, merged only once the
  merged rule is confirmed. Before approval, `host_checks` warns with
  `redirect_rule_quota` (full zone, from the zone's plan) or
  `redirect_permission_missing`, each with a remedy. A redirect write refused
  during the switch no longer goes live silently: `previous_hosts` and the
  guide record the issue code, the site still goes live with the old address
  on noindex, and the new guide action `repair_previous_host_redirects` (MCP,
  API and the portal's Repair button) re-creates missing redirects of a live
  site idempotently, without a build or DNS change.

## 0.2.140 / MCP 0.45.104 (candidate)

- Render version 13: a container that is a column at every breakpoint keeps
  its children on one flex line, and Text and Heading blocks break a word that
  does not fit. A long word, URL or inline code span no longer makes every
  child, and the page, wider than a 375 px screen. Rows and fixed-width
  children are unchanged; older render versions render as before.
- `core/navigation_links` takes an optional `group_label` (render version 13):
  a visible title above the links that names the list for screen readers,
  styled by the site's Eyebrow style or `group_label_style_id`. Lists without
  a label render as before. Its link part selectors now match items at any
  depth (`li > a`), with identical output for unlabelled lists.
- Portal: the version picker's "Promote to main…" and "Reset from main…"
  buttons are styled before their dialog has been opened.
- New site setting `header_behavior`: `static` (default), `sticky`, or
  `reveal_on_scroll_up`, which hides the header on scroll down and brings it
  back compact on scroll up, with its menu behind the menu button. Its CSS and
  script are emitted only on sites that use it.
- Domains are checked about 2, 10 and 30 minutes after going live. When another
  host (for example a previous host's Cloudflare for SaaS hostname) or another
  publication answers, the domain shows `served by another host` with the
  remedy. `check_site_indexing` reports who serves each target and no longer
  judges another host's pages as the site's.
- Web Analytics setup answers `analytics_site_limit` when the Cloudflare
  account has reached its Web Analytics site limit, with the remedy, instead
  of asking to try again. Docs describe the private media `content` read.

## 0.2.139 / MCP 0.45.103 (candidate)

- Fix domain preparation failing verification when a redirect rule captures a
  per-page Markdown file (for example `/blog/:slug` and `/blog/index.md`).
  Cloudflare Pages applies redirects before files, so such Markdown files are
  now left out of the publication and no longer announced by their page.
- The build engine's static verification names the routes that did not match
  (takes effect after a build engine update).

## 0.2.138 / MCP 0.45.102 (candidate)

- Built-in interface text (tabs, pagination, tables, breadcrumbs, media
  controls, 404 page, cookie banner) in 50 languages, and right-to-left pages
  get `dir="rtl"` with a mirrored built-in layout.
- Launch readiness: `read_site_readiness` and a portal readiness check, an
  `ai_crawler_policy` site setting expressed as Content Signals, per-page
  Markdown, `llms-full.txt`, sitemap hreflang and sitemap index, FAQ JSON-LD
  from question accordions, share-image derivatives, CSS and JSON-LD linting.
- Domain launches refuse a site still set to noindex unless overridden, and
  can turn noindex off in the same step.
- URL parity retries a redirect whose later hop timed out, and follows
  query-string redirects published as inline scripts, including from 404.html.
- Media: migration failures are set aside instead of blocking, publication
  copies an original and its variants concurrently, body image URLs with a
  query string are encoded once, and imports make fewer database calls and log
  per-transfer timings.
- Builds report jobs awaiting approval separately from active jobs. Indexing
  diagnostics confirm a new site host through public DNS.
- Docs: 11 new guides, generated skill pages, a split block reference, a
  smaller `llms-small.txt` and an MCP Registry `server.json`.

## 0.2.116 / MCP 0.45.87 (candidate)

- Publish for a new domain replaces main at the current address before DNS
  changes. DNS approval reuses that same commit and artifact without another
  push, build or upload. Later content publications retain the new origins.
- Separate saved future hosts, embedded publication origins and verified traffic.
  Guard DNS approval against concurrent publications and stale artifact receipts;
  preserve published origins when later provider checks fail.
- Refresh domain setup without rebuilding. Retain certificate, redirect,
  validation-window and rollback checks; DNS rollback does not revert content.
- Update portal guidance, public/API docs, MCP tools and starter migration
  workflow. Legacy preview-branch preparations require one explicit main
  publication. Render version remains 11; no sites are republished automatically.

## 0.2.115 (unreleased)

- Render version 11 restores contextual heading spacing through columns and
  grids, with or without saved heading roles. Opening headings remain flush;
  explicit article spacing applies once and named styles keep precedence.
- Navigation groups retain 44px touch targets without additional vertical
  gaps by default. Explicit gaps and compact desktop settings are preserved.
- Versions 1–10 retain their recorded output; preview the upgrade before
  rebuilding an existing site.

## 0.2.114 (candidate)

- Domain promotion verifies the retained artifact with the new main commit, so
  its completion resumes the approved cutover. Normalize removed CNAME-only
  DNS settings when a redirect changes record type, retaining conflict guards.

- Add fluid type/spacing defaults with mobile and desktop ratios, rhythm and
  prose line length. Named scales accept responsive maps and safe clamp values.
- Add a sandboxed three-width typography preview in Site settings → Design.
- Render version 10 scopes heading margins to editorial flow and removes top
  role margins from opening boxed headings. Component padding/gaps own titles.
  Existing render versions stay unchanged; preview cards/boxes before upgrading
  and rebuilding. Standard styles now use named steps; saved roles are preserved.
- Report unclaimed build steps separately, revoke expired queued steps without
  replacement execution, and distinguish waiting for another publication from
  a worker outage. Classify GitHub 422 failures without exposing provider data.
- MCP 0.45.85 exposes responsive scales and typography; updated design/migration
  recipes and starter QA check heading spacing at three widths.

## 0.2.113 / MCP 0.45.84 — Security follow-ups

Sessions

- Signing out ends that browser's sign-in on the server: copies of the session
  cookie, including copies refreshed by the rolling refresh, stop working. Other
  devices and MCP connections stay signed in. Enable a Firestore TTL policy on
  `expires_at` for `revoked_sessions` and `session_lineage`.
- The session cookie is verified, and the sign-out list read, once per request
  instead of once per session read.

Media

- SVGs are parsed and rebuilt from an allowlist on upload, import, storage
  migration and publish; an upload or import that cannot be sanitized is
  refused (`media_svg_invalid`). Platform-storage SVG uploads stay private
  until finalize.
- A stored SVG that cannot be sanitized no longer stops a publication: the file
  is left out, its page references become empty, and the deploy job lists it
  in `job.warnings`. A dry run checks legacy SVGs without writing anything.
  Preparing a domain change of a publication that still contains an
  unsanitized SVG returns `409 media_svg_unsanitized`: publish the site once
  first.
- Legacy SVGs in the platform bucket are rewritten in place once by the deploy
  backfill; later deploys skip them. One that cannot be sanitized is served as
  a download only when it contains script-capable content, otherwise it is left
  unchanged; both are reported in `job.warnings`. Purge the media CDN cache
  after the first deploy: cached copies of the old bytes can otherwise persist
  for their cache lifetime.
- Uploads and imports whose filename has no extension, or one of another type,
  get the type's extension appended (`logo` → `logo.png`, `x.html` →
  `x.html.png`); the response returns the stored `filename`. Renaming a
  `filename` or `public_path` to a mismatched extension returns
  `400 media_extension_mismatch`; unsupported types return
  `415 media_type_unsupported`. Legacy records with a mismatched name get the
  type's extension appended at publish and page references are rewritten; old
  direct links to those files change.
- The Media library, picker and chat uploads remove a new file only when
  finalize refuses the file itself (400 `media_svg_invalid` or
  `media_extension_mismatch`, 415, 422); a revision conflict or rate limit is
  retried and other errors keep the file.
- Static `_headers` sandbox `*.svg` and `*.xhtml` responses.
- Self-hosting: set the optional `R2_PRIVATE_BUCKET` (a bucket without public
  access) for SVG and draft uploads; `self-host:check` warns when it is
  missing, and the GCP plan binds it when `secrets.R2_PRIVATE_BUCKET` is set.

Forms

- Webhooks get one attempt of at most 3 s during the visitor's request (at most
  three webhooks); the rest retry in the background after about 1, 5, 30 and
  120 minutes with the same event id. On the Extension actions endpoint a
  queued retry counts as `ran`.
- Submissions no longer store the visitor's IP address or user agent; legacy
  values are hidden (IP from everyone, user agent from non-admins).
  `scripts/scrub-submission-network-data.mjs` removes the legacy fields from
  stored submissions (dry run by default).
- New opt-in `form_submission_retention_days` site setting (30–3650, off by
  default) deletes completed submissions after the period. Enable a Firestore
  TTL policy on `delete_at` for the `submissions` collection group.
- Rollback: Core 0.2.112 and earlier do not process `form_webhook_retry`
  scheduled work. A rollback parks every pending webhook retry: it is not
  delivered, also not after upgrading again, and its delivery record keeps the
  queued payload. Stop new submissions or let pending retries finish (at most
  about 2 hours 40 minutes after the last submission) before rolling back.

Extensions

- Extension ids are reserved per developer Organization; registering an id held
  by another returns `409`. `scripts/audit-extension-ids.mjs` reports and
  backfills reservations (dry run by default).
- Every installation token carries `developer_org_id`; providers should verify
  it in addition to `aud`. A later release will move `aud` to a developer-scoped
  value after an announced deprecation window.

## 0.2.112 — Non-root legacy Pages uploads

- Run the legacy Cloudflare Pages upload (wrangler) beside the build output in
  the OS temp directory. Since 0.2.111 the image runs as `node`, and wrangler's
  `.wrangler/tmp` under the read-only application tree failed with a permission
  error.

## 0.2.111 / MCP 0.45.83 / WordPress helper 0.4.0 — Security hardening

Rendering and portal isolation

- Escape `<style>` text inside SVG and MathML when sanitizing, so sanitized
  HTML can never carry markup there; ordinary page CSS is byte-identical.
  Password inputs are removed from authored HTML.
- Sandbox every HTML response from `/api/forms/submit`, the global block
  preview and the editor canvases; portal pages can no longer be framed by
  other sites. Page HTML is stored sanitized on every save path.

Access control

- Extension credentials: scopes are matched against the route below the site
  id, credentials act with their scope's own permission instead of admin,
  removing a scope takes effect on existing credentials, and credentials can
  no longer take over or delete other forms or change scripts, robots or
  `staging_url`. Private allow-lists use `org/site` entries; credentials see
  only their own app guide. The developer API refuses malformed
  `allowed_site_ids` entries, and `extension install --site org/site` writes
  the `org/site` form.
- Only admins of the owning Organization can mint site API keys, rotate
  Extension credentials or manage shares. Site lifecycle changes refuse keys
  minted through a share, and revoking a share revokes such keys. Listing key
  metadata requires admin.
- Organization API keys and invites require an owner or admin. Invites are
  stored, single-use by default and revocable; earlier invite links stop
  working. `/api/v1/organization/invites` accepts `max_uses` and `email`, lists
  invites and revokes them (MCP `list_organization_invites`,
  `revoke_organization_invite`).
- Changing a Site's slug or domain requires admin. Fallback hostnames are
  claimed globally, and a DNS record or custom domain held by another project
  is never overwritten (`409 slug_unavailable`).
- Preview links need write access and chat settings changes need admin. Workflow pages no longer expose helper keys.

Outbound requests

- One guarded client for WordPress migration, preflight, URL verification,
  link checks, sitemaps, webhooks and diagnostics: public addresses only
  (including IPv4-mapped, NAT64 and 6to4 forms), connections pinned to the
  validated address, every redirect re-validated, time and size bounded.
  Migration only fetches item links on the source site. Self-hosted installs
  can allow private migration sources with
  `TYPEROLL_ALLOW_PRIVATE_NETWORK_FETCH=1`.
- SMTP connectors accept public hosts on ports 25, 26, 465, 587, 2465, 2525 and
  2587 and report generic errors.

Forms and Analytics

- Rate limits use the trusted proxy hop (`AUTH_TRUST_PROXY_HOPS`); proof of
  work is single-use; bodies are bounded while read; answers must be
  primitives within length limits; autoresponders to submitted addresses are
  throttled; app-targeted forms refuse direct submissions. New Analytics
  tokens use a separate signing key (`analytics-v2`; v1 still accepted).

Packages, images and release

- WordPress helper 0.4.0 exports only public post types, returns protected
  posts without content, refuses underscore meta outside an allowlist, reduces
  ACF user and post objects and accepts its key only in the header.
- MCP 0.45.83 sends a workspace key only to the hosted portal or one matching
  `TYPEROLL_API_URL`, and requires HTTPS except on loopback.
- The Core image runs as `node`. Compose trusts one proxy hop and keeps
  publishing and signing secrets out of the public forms service.
- Release OSS reuses only the image digest recorded by Tests, grants each job
  only its own permissions and pins actions by SHA.

## 0.2.107 / MCP 0.45.81 — Focused settings and guided domain migration

- Split Site settings into seven linked sections with independent saves and retained unsaved inputs.
- Add a shared UI/API/MCP domain checklist, explicit DNS inventory review, bounded validation and journaled traffic rollback.
- Preserve verified candidates when only redirect hosts change; reuse compatible origin-only output and promote the same artifact without a second build.
- Retry transient media preparation failures in the same frozen job. Share Pages redirect limits between preflight and upload.
- Retain explicit late domain preparation: normal publication keeps using the active or temporary address, and newer content invalidates an older candidate.
- Keep design tokens editable in the Design section without resetting unrelated settings.

## 0.2.106 / MCP 0.45.80 — Site design tokens and migration safeguards (unreleased)

- Make the expanded mobile site selector scroll with the drawer (F33, from PR #82).
- Resolve palette names in block colour fields in static output and preview;
  preserve stored names and report unknown colours as `field_type_mismatch`.
- Add configurable typography, spacing and line-height scales, responsive step
  values, palette-first editor controls and a site-owned mono font role.
- Add read-only `lint_design_tokens`, non-blocking launch findings and a starter
  dry-run migration for exact, unambiguous scalar hex matches in a test Version.
- Keep normal publication on the active/temporary host after future domains are
  saved. Prepare the last published snapshot for a domain switch only on explicit
  request; release waiting candidates from the publication lock, reject outdated
  cutovers and disclose frozen indexing settings in UI/API/MCP (F35).
- Add local ICC-aware original-to-sRGB image preparation and source-media
  archival guidance; never delete originals or automatically retire hosting.
- Update public docs, design/migration recipes and generated starter guidance.
- Capability contract 0.54.0 invalidates old output dependencies. Render reference
  updates add previously unused scale/hover/mono variables and opt-in mono rules;
  existing numeric values and existing font choices retain their output.

## Core 0.2.103 / MCP 0.45.79 (prepared)

- Complete reusable migration feedback: native responsive slot/section/hero
  controls, heading-role spacing, text wordmarks, intrinsic image sizing and
  accessible click-to-load videos; refresh renderer references for the fixes.
- Check known parent backgrounds for global part styles and same-origin current
  navigation. Expose post-card image alt without losing decorative semantics.
- Discover bounded public WordPress URLs; distinguish draft targets, report
  redirect chains and exact Search Console access requirements.
- Require explicit acknowledgement of unsaved content before queueing a deploy;
  expose exact-task file/attempt progress and a signed rendering-only frame URL.

- Add version-bound migration QA helpers to the generated site workspace: unsaved-content checks, deployed URL/media checks, screenshots, card hit tests and preserved-text comparisons. Preserve edited scripts on update.
- Correct header/footer, grid and WordPress recipes; explain when public REST is sufficient and when a helper/export is needed. Record all Ulvon migration findings with priorities and follow-up scope.
- Preserve page append_seo_suffix through the working-copy/save path, including false. Existing saved preferences and customer copy are not changed.
- Fix post-card whole-link hit areas and faded body/meta contrast for all supported render versions. The render references change only for that corrective CSS; no new render version or automatic customer publication is introduced. Conflicting secondary actions now produce a write warning.

## Core 0.2.100 / MCP 0.45.77

- Expand the website workspace with owner rules, SEO strategy, canonical starter prompts and a resumable guided interview. Choose text and design/image preservation independently, with explicit asset/metadata exceptions. Keep edited project files and interview answers on update.
- Clarify that the managed WordPress import stages HTML and the external agent reconstructs editable blocks. Remove obsolete editor-conversion instructions from public docs and workflow messages; no import/conversion behavior changes.

## Core 0.2.89 / MCP 0.45.69

- Define preserve and renew migration approaches, with a shared editable-block hierarchy and continuity for every old public URL. Include art-directed hero HTML exceptions and explicit content/design acceptance references.
- Allow reasoned, exact custom-type and HTML-block reviews in composition preflight without bypassing missing dependencies or infrastructure checks. Return those decisions as `reviewed_exceptions`; hosted verification remains required.
- Align MCP recipes, generated workspace briefs, portal chat guidance and public migration docs. Remove stale HTML-first, media-host and breadcrumb guidance from the chat playbook.

## Core 0.2.88 / MCP 0.45.68

- Update Astro to the corrected 7.3 patch line and ip-address to 10.7.4 for the release security gate.

- Indexing diagnostics recognize the intentional robots block on customer temporary hosts when no future website host is saved, and report the expectation reason.
- WordPress imports prefer UTC date fields; Helper 0.3.3 labels GMT values explicitly. Generated Article and Content type dates retain known offsets; legacy timestamps with unknown timezone use date-only precision rather than invented UTC. Existing content is not rewritten.
- Hosted MCP regression coverage verifies domain redirect/cutover fields in full and compact catalogs and calls; document refreshing stale client catalogs. Both fields were already served by production MCP 0.45.67 at verification time.

## Core 0.2.87 / MCP 0.45.67

- **Cloudflare permissions for Analytics and redirects are part of onboarding.** When the deployment lists them in `TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES` (and the OAuth client allows them), Connect Cloudflare requests Account Settings Write and Account Analytics Read (Analytics) and Dynamic URL Redirects read/write (redirect hosts) together with the publishing permissions. Unset, Connect Cloudflare requests exactly what it did before.
  - Existing connections show **Approve update** on their Cloudflare card. One approval renews every connection in the Organization that uses the same Cloudflare account (each keeps its own grant; Cloudflare may show its consent page once per connection); existing permissions, keys and Sites are kept. The approval enables Analytics on no Site.
  - New Publishing → **Analytics** overview lists the Organization's Sites with Analytics on/off and setup status and enables or disables several at once; the same through `GET/POST /api/v1/organization/analytics` and MCP `list_organization_analytics` / `set_organization_analytics`, with a result per Site. Analytics stays opt-in per Site.
  - With the redirect permissions, the `www` redirect rule is created automatically; without them `redirect_rule_required` names the update.
  - `read_organization_publishing_connections` (`cloudflare_permissions`) and `diagnose_organization_cloudflare_connection` (`permissions`) report analytics provisioning, analytics reports and redirect rules with the exact missing scopes and the one next step.

## Core 0.2.86 / MCP 0.45.66

- **Everything the built-in chat knew is available to your own agent.** With the portal assistant now optional per Organization and Site, its help moved to MCP:
  - New MCP tools `add_faq_schema`, `add_recipe_schema` and `add_event_schema` build validated schema.org JSON-LD (ISO 8601 dates and durations, currency with prices, absolute URLs) and merge it into the page's draft `json_ld`: a node of the same `@type` is replaced and other nodes are kept, and invalid existing JSON-LD is refused instead of overwritten. The portal chat uses the same builder, so it no longer replaces a page's whole `json_ld` when adding an FAQ.
  - The chat's playbook (preview links, images, page edits, site-wide changes and reusable sections, header and footer, settings, analytics with the cookie banner, URL and SEO conventions) is now in the `tr-edit-site` and `tr-seo` recipes and the agent guide. The starter design notes are the new `tr-starter-design` recipe, which the chat also reads.
  - AI workflows (content generation and improvement, schema markup, site planning) say what to do on `ai_not_enabled`: don't retry; do the same work with `tr-content-write`, `tr-seo` or `tr-new-site`. Failed workflow runs record a stable `failure_code`.
  - Fixed: `schema_markup` without AI access skipped every page and reported success; it now fails with `ai_not_enabled`.
  - The agent workspace starter points agents at the everyday-request recipes.
- **"Check your email" continues by itself.** Only the server knows whether an address is confirmed, so the page now asks it when it opens (including after the confirmation link brings you back), when the tab is shown again, and every 10 seconds for 15 minutes while it is visible, then continues automatically. The "I've confirmed my email" button is gone; **Send confirmation email** is the main action.

## Core 0.2.85 / MCP 0.45.65

- **Breaking: no platform AI key. Each Organization adds its own and chooses its Sites.** The built-in AI assistant used one server-wide `ANTHROPIC_API_KEY`, so every editor in every Organization used the platform's account. Owners and admins now add the Organization's own Anthropic key in Organization settings → AI assistant (or `PUT /api/v1/organization/ai/key`, MCP `set_organization_ai_key`). The key is verified with Anthropic, encrypted with `INTEGRATIONS_SECRET_KEY`, never returned (only its last four characters) and used only on the Sites the admin selects (all Sites, or a list; none by default). On a Site without access the chat, its entry points and the AI workflows are hidden or refused with `ai_not_enabled`; "Plan a new site with AI" refuses before creating anything. A shared Site uses its owner Organization's key. MCP, the public API, OAuth connections and API keys are never affected: people's own agents work on every Site. `ANTHROPIC_API_KEY` is no longer read; self-hosters see a warning if it is still set. After upgrading, nobody has the built-in assistant until an owner or admin adds a key.
- **Migrations use your own agent.** The unused WordPress AI page reconstruction is removed, the built-in chat has no migration tools, and the migration recipes and guides say migrations run in Claude Code, Codex or another MCP client.
- **Confirmed email for every account, and optional GitHub sign-in.** Sign-up sends a confirmation link. Until the address is confirmed a session only reaches "Check your email" (resend, "I've confirmed", sign out): it cannot create or join an Organization, accept invites, approve MCP access, manage API keys or open a Site, and personal MCP credentials of unconfirmed accounts are refused. Sessions are re-checked on every request, so existing accounts without a confirmed email are asked to confirm at their next page view; their memberships are kept. "Continue with GitHub" (Firebase GitHub provider, `user:email` only, never repository access) appears when `PUBLIC_FIREBASE_GITHUB_SIGNIN=true`; GitHub addresses are confirmed by email like any other, and an address that already has a password account is linked after the password is entered. `login?mode=signup` opens account creation directly.
- **Analytics for customer publishing uses the Organization's Cloudflare account.** Enabling Analytics on a customer_git Site provisioned the Web Analytics site in the platform's account (or silently failed), and Insights read the platform's account. It now provisions in and reads from the Site's Hosting Group account, records which account owns the beacon, and returns structured causes and next steps from `update_app`, `read_app` and `get_site_insights` (`analytics_cloudflare_access_required`, `connection_required`, `access_required`, `account_mismatch`, `provider_error`). Creating the Web Analytics site needs Account Settings Edit and reading reports needs Account Analytics Read; "Approve Analytics access" on the Analytics card requests them. The beacon stays cookieless and outside the consent gate.
- **customer_git: redirect hosts and apex checks.** `set_publishing_domains` accepts `redirect_hosts` (for example `www`), served as a 301 to the website host by a Single Redirect rule in the zone that Typeroll creates through the Organization's connection (or shows for you to add); cutover verifies the redirect. Domain settings report `host_checks` up front: an apex needs an active Cloudflare zone in the hosting account (`apex_zone_required`, `zone_not_active` with the assigned nameservers, `apex_zone_in_other_account`). An apex that already serves traffic can be switched by approving with `accept_validation_window`, with Cloudflare's documented certificate window and the records to restore; `domain_prevalidation_unavailable` explains this instead of "contact support".
- Dependencies: vitest 4.1.12 (`@vitest/mocker` advisories GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp; development only).
- **Migrations carry no source scripts; analytics move by ID behind consent.** A migration had copied JavaScript from the source site's WordPress plugins, and nothing in the routine or the launch gate stopped it.
  - `get_migration_launch_report` has a `scripts` section and is not `launch_ready` when a script loads or uses the source platform's runtime (`source_runtime_script`: wp-content plugins/themes, wp-includes, admin-ajax/REST, jQuery, emoji, page builders, form plugins, WooCommerce, cookie plugins), when tracking code (GA/GTM, Meta, LinkedIn, TikTok, Hotjar, Clarity and others) runs outside the consent gate (`tracking_outside_consent`), or when an analytics or advertising integration is enabled with the cookie banner off (`tracking_without_consent_banner`). It inspects settings and cookie-consent scripts, live pages, partials, page templates and site block types; only `<script>` elements and block type scripts count, so copied markup that mentions a plugin class is not a finding.
  - The migration recipes (`tr-migration-evidence`, `tr-migrate-wp`, `tr-import-url`, `tr-migrate-astro`, `tr-migrate-multisite`) decide every source script: platform, theme, plugin and cookie-plugin JavaScript is never copied; analytics and advertising tags are set by ID in the Integrations app with the cookie banner on; a tag the catalog lacks goes only in `cookie_consent.scripts_optional`. `tr-import-url` no longer suggests pasting GA into `scripts_head`, and neither do the `scripts_head`/`scripts_body_end` tool descriptions or the portal assistant.
  - The WordPress migration guide explains what happens to scripts, analytics and cookie consent.

## Core 0.2.84

- Fixed: a publication whose build failed validation could be reported as failed without its validation report (`seo_report`). A status read that found the failed build marked the job failed before the publication runner attached the report, so the portal, the API and MCP could show "validation failed" without the errors that explain it until a later read. The failure now carries the report from the first read.

## Core 0.2.83 / MCP 0.45.64

- `core/image`: the mobile image (`mobile_src`) can switch at the block's or Site's breakpoint instead of the fixed 640px. `mobile_src_below` (`640` | `tablet` | `laptop` | `desktop` | `wide`) resolves against the block's `responsive_breakpoints`, else the Site's, and switches below that width (`(width < 768px)` for a laptop width of 768px). `mobile_src_below_px` (320–2560) sets an exact width and takes precedence. Unset, the markup is unchanged (`(max-width: 640px)`), so no render version is needed. On moveria.se the mid-article banner switched at 640px while legacy switched below 768px, so 641–767px showed the wrong image.

## Core 0.2.82

- Security: sanitize-html 2.18.1 (from 2.17.7), the sanitizer Core uses for rich text. It fixes content rendering after an implied close in non-text tags such as `<noscript>` ([GHSA-x3q4-9hxx-gx8m](https://github.com/advisories/GHSA-x3q4-9hxx-gx8m)), a SMIL animation namespace-prefix bypass that allowed `javascript:` URLs ([GHSA-374f-7chj-9948](https://github.com/advisories/GHSA-374f-7chj-9948)) and `javascript:`/`data:` URLs in `meta http-equiv="refresh"` content ([GHSA-cv27-6wvh-8x7j](https://github.com/advisories/GHSA-cv27-6wvh-8x7j)).
- Security: vite 8.2.4 (from 8.2.2) fixes the high-severity launch-editor advisories, which affect only the development server.

## Core 0.2.81 / MCP 0.45.63

- **Render version 9: container shadows above the next block.** A `core/container` with `shadow: "subtle"` or `"header"` was `position: static` without a z-index, so the next block, such as a hero with a background or image (`position: relative`), painted over its shadow; on moveria.se the header banner's shadow did not show on `/` or `/tips-om-flytt/`, and the only workaround was `inline_style`. From render version 9 such a container is `position: relative; z-index: 10`, so its shadow shows over the following blocks. A sticky container keeps z-index 100, and 10 stays above block-internal layers that form no stacking context (the hero's content is z-index 2), so a menu opening from a shadowed header lands above the next block. The `header` shadow becomes `0 2px 6px rgb(0 0 0 / 20%)` instead of `0 2px 5px`, as legacy headers draw it. A shadowed container is now the containing block of its absolutely positioned content. Versions 1–8 render as before; a browser test checks the shadow, a dropdown over a hero, sticky and unshadowed containers, and the old behaviour on version 8.

## Core 0.2.80 / MCP 0.45.62

- **Block parts: style any part of a core block with a named style, without site CSS.** An audit found 421 presentational values (size, weight, radius, spacing, opacity, underline, shadow, colours) in the CSS of 49 core blocks that no field, style or variable reached; moveria.se's underlined category heading links were one. Every core block now declares its parts (`BlockType.parts`: name, selector, style kind), 229 in all, listed by `read_block_type` and in the docs.
  - Choose a style for a part on one block (`data.part_styles: { <part>: <style id> }`, or the block's existing style field such as `eyebrow_style_id`), or for every block of a type (a style's `parts: ["core/rich_heading.link"]`). The block's choice wins. Blocks whose surface is the block itself got a `style_id` (card, CTA, accordion, table of contents, search, divider, icon, columns, tabs, form fields, template blocks); the repeater got `group_title_style_id` and `pager_link_style_id`.
  - Part rules are scoped to the block, beat its own CSS and the shared text-link rules without `!important`, follow declaration order where parts overlap, and are emitted identically on published pages, previews and the editor. With no part style chosen, markup and CSS are unchanged: the render-version references did not change, so no render version is needed.
  - Every write checks part styles: unknown parts are `unknown_field` with suggestions, wrong style kinds and unreadable contrast (APCA, on the part's surface) are refused by `add_block`/`update_block` and reported by tree writes; the styles API checks part targets. Styles gain link and image kinds and `opacity`, `shadow` and `gap`.
  - A form field's invalid border wins over any chosen input style; focus indicators cannot be removed by a style.
  - Guards: a test fails on any new presentational value no part, style or variable reaches (12 documented exceptions remain, such as the hero video pause control), on any declared part that does not render, and when the documented parts table differs from the definitions. See `docs/plans/block-parts.md`.
- `core/rich_heading`: `link_decoration` and `link_hover_decoration` (`inherit` | `none` | `underline`) set the underline of the heading's links, so a category heading can link to its page without an underline while body links keep the site's Link style. Unset, the links follow the Link style (`--link-decoration`) as before; the focus outline stays visible. The attributes appear only when set, so existing markup is unchanged and the block's CSS reference is updated for every render version instead of gating it.
- MCP: `read_block_type` lists parts; `update_block` takes `part_styles`; style tools take part targets and the new properties.

## Core 0.2.79 / MCP 0.45.61

- **Render version 6: browser-default font smoothing.** The template reset no longer sets `-webkit-font-smoothing: antialiased` and `text-rendering: optimizeLegibility` on every site. On macOS that drew dark text on a light background thinner and lighter than other sites at the same weight, so migrated sites looked lighter than their originals. New sites and sites upgraded to render version 6 use the browser default (`auto`). Versions 1–5 render as before: the rule moved from `reset.css` to the theme CSS for those versions, so their computed styles are unchanged and the platform CSS reference changed in text only.
- **Render version 7: video, ratings and carousel controls.** Options these blocks declared were stored and never rendered:
  - `core/video` was a bare iframe of the authored address, so a YouTube watch address did not embed, and `poster`, `autoplay`, `loop`, `muted`, `controls` and `lazy_load` did nothing (a comment promised a URL conversion that did not exist). It now embeds YouTube (no-cookie host) and Vimeo page addresses with those options, plays video files in a native player, and has an accessible `title` (default "Video").
  - `core/hero.video_url` plays a video file as a muted, looping background with the image as poster and a pause button; nothing plays when the visitor prefers reduced motion.
  - `core/testimonial.rating` shows whole stars with "Rating: 4 out of 5" ("Betyg: 4 av 5") for screen readers.
  - Repeater carousels (`core/testimonials` and `layout: "carousel"`) get previous/next buttons, a dot per item and optional autoplay with a pause button, per `show_arrows`, `show_dots` and `autoplay`. Autoplay stops on hover, focus and pause, and never runs under reduced motion. Items scroll in a track inside the block; without JavaScript it still scrolls.
  - Versions 1–6 render byte for byte as before. Block types can now version their `script` as well as template and styles (`render_versions[].script`), so the new hero and carousel runtimes and their `data-block-type` hooks reach only version 7 sites. Site block types cannot write `render_versions`, and the publication carries no script from them.
- **Render version 8: text on theme colours by APCA.** The automatic black/white text on primary, secondary and accent used the WCAG 2 ratio, which overrates dark text on mid-dark saturated colours: on #00a19c it picked #111827 (APCA Lc 44.0) over white (Lc 63.9). From version 8 the choice uses APCA (APCA-W3 0.0.98G-4g, `packages/shared/src/contrast.ts`). Versions 1–7 render as before; a new reference records site style and theme colour CSS per version.
- New: `colors.on_primary`, `colors.on_secondary`, `colors.on_accent` choose the text colour on each theme colour (Settings → Colors: Automatic or a colour, with both measures; v1 API validates hex, `null` clears; MCP and the static publication carry them). A chosen colour applies on every render version; one below APCA Lc 60 is kept with a warning that gives both measures and the automatic alternative.
- Style contrast checks use APCA levels by size and weight (body Lc 75; non-body text from 16px/600, 21px/500 or 24px/400 Lc 60; from 24px/700 or 36px Lc 45; secondary text 15 less) and report Lc and the WCAG 2 ratio. Text that fails both APCA and WCAG 2 AA is refused; text that misses its APCA level but meets WCAG 2 AA is saved with a warning. Style writes return `{ style, warnings }`. Adding standard styles still adapts an unreadable palette colour, but each change is now reported in `warnings` instead of happening silently. White at 16px/600 on #00a19c passes for buttons; note that it does not meet WCAG 2.1 AA below 24px (18.66px bold).
- `add_block` and `update_block` reject `data` keys the block type does not declare: 400 `unknown_field`, naming each key with where it belongs (`item_overrides.<key>` for an item-block field on a repeater or its aliases, `style_overrides.<key>` for an override name, else the closest field names). Nothing from a rejected request is written. Aliases accept their own and their target's fields; keys the renderer reads without a declaration (`responsive_breakpoints`, names a site type's template or composition reads, a conditional's condition) are allowed. Page, partial, batch and working-copy writes save and return `unknown_field` warnings. `set_block_responsive` rejects undeclared fields. In the v1 API, `null` in `update_block` removes a key.
- Block write answers can be compact: `response: "summary"` (body or query) on add, update, move, remove, duplicate and responsive returns the block, `parent_id`, `slot_index`, `position`, `has_unsaved_changes` and warnings instead of the whole tree. The HTTP default stays `"tree"`; MCP asks for the summary by default (as a query parameter, which an older Core ignores) and takes `response: "tree"`.
- `create_page` no longer renames an explicit slug: a slug or path already in use, including by a draft or an unsaved draft, answers 409 `slug_in_use` / `path_in_use` with `details: { page_id, path }`. Only a title-derived slug is numbered, with a `slug_adjusted` warning. When only the internal id is taken, the id is numbered and the slug kept. The portal's New page form shows a notice when it numbered a taken slug.
- Fixed: `core/form.submit_label` was ignored because `formSource` received only the form id. It now receives the block's options (`formSource(formId, { submit_label })`) and the label replaces the form's `submit_text`, in published pages and previews.
- Fixed: a required radio or checkbox group was enforced only by the server. A required radio group is now required in the browser, and a required checkbox group needs one checked box before the step is sent (the browser's own message and focus). Groups that are not required render as before.
- New setting **Typography → Font smoothing** (`fonts.smoothing`: `auto` or `antialiased`, `null` clears it) for light text on dark backgrounds. An explicit choice applies on every render version. The v1 settings API validates it, and the static publication carries it.
- Fixed: an address field with `suggest_address` looks like the block's other fields. Google's `PlaceAutocompleteElement` replaced the block input with its own fonts, 1px black border, 3px radius, 50px height and `color-scheme: light dark`, and none of the block's input settings reached it. The Places loader now maps the block's field contract (`--tr-field-*`, set by `core/navigation_form` from its input settings) onto the element's supported styling: host properties, `::part(input)`, the prediction parts and the `input-icon` slot. Border, radius, height, padding, background, text colour, font, size and placeholder colour match a plain field at every breakpoint; the colour scheme follows the site; the magnifier takes the field's text colour; the suggestion list uses the block's font; and the Maps API's Roboto and Google Sans stylesheets are not loaded. Focus ring, keyboard selection and the handoff are unchanged. This is an ungated fix: it applies on every render version, and only to fields with suggestions.
- `core/navigation_form`: `button_icon` (core icon name or text, rendered after the label with `aria-hidden`), `button_icon_size_px`, `button_icon_gap_px` and `button_font_weight` (responsive; default 600). Unset, the markup and the computed button are unchanged, so the block's CSS reference is updated for every render version instead of gating it.
- Block field types: a number field written as numeric text, such as `active_font_weight: "600"` on `core/tabs`, renders as that number, including values already stored. Values that still cannot render (non-numeric text in a number field, text in a boolean field, a select value outside its options) are reported as `field_type_mismatch` write warnings with the path, the field and the expected type. `add_block` and `update_block` now return warnings for the fields they write, checked against core and the site's own block types; page, partial and batch writes report core block types.
- The Places loader uses Google's `quarterly` release channel (Maps JS 3.65 at the time of writing) instead of `weekly`, so Google's element changes reach sites once a quarter and can be checked first. Everything the loader uses exists in 3.65.
- Page, partial and batch writes check block trees against the site's own block types as well as core (`field_type_mismatch`).
- Migration recipe: `tr-migration-evidence` has a section on reporting platform gaps instead of patching them with site CSS, with the five causes to check and the fields a report needs.
- Guards against settings that are stored and never reach the page. See [docs/plans/field-presentation-contract.md](docs/plans/field-presentation-contract.md).
  - A browser test compares the suggestion field with a plain field at 390 and 1280 px in light and dark browsers. It runs against a stand-in with Google's default styles and against the real element from the quarterly channel; the second variant is skipped, with the reason, only when Google is unreachable. It runs in Chromium, Firefox and WebKit in CI.
  - Every schema field of every core block must change the rendered markup or CSS when set. Fields that need runtime data are listed with where they are tested. The test found eleven fields that were accepted and never rendered, all fixed in this release (above); a field added to the known-defect list later fails the test once it starts rendering, so the list stays true.
  - A browser test drives the carousel controls, autoplay and reduced motion, the hero video's pause button, a YouTube embed through the published sanitizer and a required checkbox group, in Chromium, Firefox and WebKit in CI.
  - Every `SiteSettings` field, read from the type, must be carried by the static publication or listed as deliberately unpublished.
  - Declarations on bare element selectors in `reset.css` and `global.css` must be neutral resets, read a variable a setting or style sets, or be listed with how a site changes them.
  - A unit test fails when a block writes a presentation variable that no platform CSS reads.
- MCP: `update_site_settings` describes `fonts.smoothing` and `colors.on_*`; `update_block` describes `field_type_mismatch` and `unknown_field`; the block write tools answer compactly; `create_page` and `clone_page` describe slug conflicts.

## Core 0.2.74 / MCP 0.45.56

- Fixed: the first publication after upgrading to Core 0.2.72 or 0.2.73 failed while preparing media (`media_build_process_exit_1`) for every site with already-published images. Media receipts recorded the exact image encoder, and reuse required it to match, so the sharp 0.35.5 security update rejected every receipt written by 0.35.4 (`Invalid media completion receipt`). A receipt is now reused when its variant verifies against its own SHA-256; the encoder is still recorded, and a changed transformation still requires a new recipe version in the object key. Nothing is encoded again.
- Every failed build now says which step failed, why and what the step printed. The build engine keeps the output of each step (both streams) instead of only matching a few system codes, removes the attempt's exact credentials and anything credential-shaped, writes the tail to its own build log (`TYPEROLL_BUILD_LOG`, `TYPEROLL_BUILD_CAUSE`) and reports the cause and the last 40 lines with the failure. The coordinator redacts it again. The deploy job's error reads, for example, "The build failed while preparing images and files: the step exited with code 1. Cause: Error: Invalid media completion receipt." with the code last; `failure.diagnostic` keeps `{ cause, lines }`, and the portal shows them under **Build output** on the deploy status and in the deploy history. This works for the Cloudflare and the GitHub engine, and for failures of the build supervisor itself.
- Every reported failure code has a readable step and reason: dependencies, media, Extension assets, rendering, upload and verification; time limits, exit codes, missing modules, native modules that cannot load, disk and memory exhaustion, storage transfers, output limits and an engine too old for this Core.
- **Publishing → Builds** says **Build engine update available** when a ready engine runs older generated code than the installed Core. Publishing keeps working. Update the engine to get readable build failures.
- MCP: `get_deploy_status` describes `failure.diagnostic`.
- Release gate: `scripts/publication-upgrade-check.mjs` publishes media prepared by each of the three previous Core releases, using that release's own media code and locked sharp and S3 client, with the release candidate. A candidate that cannot publish what an earlier release prepared, changes the bytes of a published file or prepares media again under the same recipe version does not ship. It reproduces the 0.2.72 failure against the earlier media code.

## Core 0.2.73 / MCP 0.45.55

- Preview writes the page identity attributes on `<body>` (`data-route`, `data-page`, `data-content-type`, `data-template`, `data-depth`), the same as the published build, so page-scoped CSS such as `body[data-route="home"] .header-banner` looks the same in both. The docs show how to vary a block in a shared partial by page with its own `custom_class`.
- `core/image` gets `spacing_before_px` and `spacing_after_px` (0–480 px, per breakpoint). In page flow the larger of the value and the next block's own space applies; in a Container or Grid the gap is added. Unset changes nothing, so existing pages render as before: the markup is identical and the two new rules only match the attributes a set value adds, so the image CSS reference is updated for every render version instead of gating it.
- A failed build on the Cloudflare build engine names its cause. Typeroll reads the build's log with the organization's build connection, once, and appends the most specific failure line to the deploy job's error (`Build log: …`) instead of only "Check the build log". `failure.provider_log` keeps the step (build or verification), the Cloudflare build ID and the last 60 lines, with credential-shaped values removed and digests and commit IDs kept. The portal, API and MCP `get_deploy_status` show it; an unreadable log leaves the job unchanged.

## Core 0.2.72 / MCP 0.45.54

- Security: @modelcontextprotocol/sdk 1.32.1 (GHSA-6qxp-vccf-f47h; minimum raised to ^1.31.0) and sharp 0.35.5 (GHSA-wq5f-xc86-pv6w, librsvg CVE-2026-96889).
- Release: live documentation verification retries a page that still answers 404 at the edge for up to 30 seconds after `release.json` reports the new source, instead of failing the release on the first request. The deliberate 404 check is unchanged.
- Tests: the GitHub setup-return test checks that the foreign installation id was not recorded, instead of searching the stored diagnosis for `999`, which also matched timestamps ending in `.999`.

## Core 0.2.71 / MCP 0.45.53

- A top-sticky or fixed site header now reserves its own space. The page runtime measures the header's bottom edge and sets `html { scroll-padding-top }` to it plus 16px, updating when the header resizes or crosses a breakpoint. Fragment links and `:target`, `scrollIntoView()` from blocks and Extensions, and `focus()` on form fields land below the header, on the published site and in preview. Pages without a sticky header, and sites that set their own `scroll-padding-top`, are unchanged. The outline adds only clearance the page has not already reserved, so its links land on the same line. Remove tenant `scroll-margin-top` offsets that duplicate it.
- Publishing: Media storage is the last card in the Cloudflare tab, and the Cloudflare tab turns green only when both the account and media storage are ready. Links to `#media` and `#media-title` open the Cloudflare tab.
- MCP: `tr-page-template` describes the native header clearance.

## Core 0.2.70 / MCP 0.45.52

- Publishing is split into tabs: GitHub, Cloudflare, Media storage, Builds, Hosting Groups and Domains. Each tab shows the status symbol of its cards (ready, in progress, needs attention), so a problem stays visible from any tab. Existing links such as `/app/settings/publishing#publishing-builds` and `#media-title` open the matching tab, and returning from Cloudflare authorization opens the Cloudflare tab.

## Core 0.2.69 / MCP 0.45.52

Several Typeroll Organizations may use one Cloudflare account, for example one owner with several companies kept apart so that a site can be transferred later.

- Fixed: an Organization could not connect a Cloudflare account that another Organization had ever connected (`claimed_by_other_organization`). The reason told people to disconnect it there or ask for a transfer, but disconnecting kept the claim and no transfer existed.
- Shared Cloudflare accounts:
  - The account claim lists the Organizations and Hosting Groups that use the account. Joining an account another Organization uses requires a person who is an owner or admin of at least one Organization that already uses it. The role is read from the member documents when the account is connected, for OAuth (automatic connection and account choice), API tokens and Hosting Groups.
  - The person confirms first: the card says **This Cloudflare account is also used by: …**, naming only the Organizations they administer, and that sites stay separate. A single authorized account that other Organizations use is offered as a choice for this confirmation instead of being connected directly. The portal routes return `409 shared_account_confirmation_required` with `details.shared_with`; the request is repeated with `confirm_shared_account: true`.
  - Anyone else gets `claimed_by_other_organization`, now with `who: organization_admin`, a message that names no other Organization and says who can connect the account (an owner or admin of an Organization that uses it, or Typeroll support), and a link to [Sharing one Cloudflare account](https://typeroll.com/docs/guides/cloudflare-troubleshooting/#sharing-one-cloudflare-account). An organization API key (API and MCP) cannot join an account another Organization uses. An Organization whose own saved connection names the account may always reconnect it.
  - Disconnecting removes only that Hosting Group's, and then that Organization's, use of the account. The claim is deleted when no Organization uses the account.
  - Claims written before sharing (`{ org_id }`) keep working: they are read as that Organization's current use and upgraded on the next write. Its buckets are recorded as its own before another Organization joins.
- Isolation inside a shared account:
  - Generated names are unchanged and were already derived from the Organization (and Site): R2 buckets, the build Worker, the media transfer Worker, and each Site's Pages project and repository. Nothing is renamed or moved.
  - Typeroll records which Organization owns each R2 bucket, Pages project and Worker before creating or changing it, and refuses an operation on another Organization's resource (`cloudflare_resource_owned_by_other_organization`), including a bucket typed in the API-token form that another Organization uses. Media buckets are never shared between Organizations.
  - A hostname whose DNS points to another Organization's Pages project is never prepared for replacement (`hostname_used_by_other_organization`).
  - The shared build engine no longer selects the account's only build token by assumption when other Organizations use the account; the token selected on the Organization's own build project is used.
  - The organization-level diagnosis (other admins, API keys, MCP) never contains the Organizations a person administers.
- GitHub claims are unchanged: one GitHub account still belongs to one Organization.

## Core 0.2.68 / MCP 0.45.51

- Security: proxy-addr 2.0.8 (GHSA-jqcg-44mw-7w3h), source-map-js 1.2.2 (GHSA-68fv-2mgg-jv7q), smol-toml 1.9.0 (GHSA-r4xh-jqrq-34v2) and postcss-selector-parser 7.1.6 where its range allows (GHSA-rj75-hqrm-r3gf). Lockfile only.

## Core 0.2.67 / MCP 0.45.51

- Extension page handoff (Extension runtime 0.43.0, template capabilities 0.52.0, `supports_extension_page_handoff`). An Extension component can receive what a visitor typed into a native `core/navigation_form` banner on the previous page: `await context.handoff.read()` resolves `{ key, source: "navigation_form", values, parts }` or `null`. `values` are the typed field values with address parts as `<field>_<part>`; `parts` groups `street`, `street_number`, `postal_code`, `locality`, `country` and `formatted` per field. Embedded apps use `typeroll.extension.handoff.read` / `typeroll.extension.handoff.result`.
  - Access needs the component's manifest declaration `page_handoff: true`, the new `page_handoff:read` permission granted by the site administrator, and the page author's binding of the block instance to the banner's defaults key (`page_handoff_key`, shown in the editor as **Prefill from navigation inputs**). Otherwise `read()` resolves `null`; so does a handoff that is absent, expired or addressed to another page. Nothing throws.
  - The handoff is taken out of tab storage once per page load, as by a native receiving form; every bound component on that page receives the same values. The storage key and packet format stay private to Core and are not part of the Extension contract.
  - Runtime 0.43.0 is additive: releases declaring `^0.42.0` or `>=0.38.0 <1.0.0` stay compatible. A release that uses `page_handoff` should declare `>=0.43.0 <1.0.0`.
- Preview links carry the navigation form handoff. An opaque preview has no Web Storage, so a banner's values were lost and Continue navigated the isolated frame out of the preview shell. The preview shell now keeps the handoff for the tab and the banner moves the shell to the destination, for both a native receiving form and an Extension component.
- Fixed: a receiving `core/navigation_form` with more than four fields received no defaults, because the field-and-address-part allowlist was capped at 32 names.

## Core 0.2.66 / MCP 0.45.50

Connect Cloudflare now explains every way it can stop, who must act and how, inside the Cloudflare card, each Hosting Group card, the API and MCP.

- Fixed: a Cloudflare sign-in that failed after consent showed the card unchanged ("Not connected · Connect Cloudflare") with only a page-level alert, and nothing was recorded. Every failure was reported as `?cloudflare=failed`.
- Cloudflare connection diagnosis:
  - Every exit of the Cloudflare flow (start, callback, account choice, Check again) stores a diagnosis for 24 hours per Organization and Hosting Group. It lists the accounts the person authorized, whether each can be used, and each blocker with `who` (`you`, `cloudflare_account_admin`, `publisher`, `typeroll_admin`) and one action. No tokens, OAuth codes, state values or Cloudflare responses are stored or returned.
  - A callback is recorded only for the sign-in the same person started in the same browser, so a link to the callback from another site changes nothing. A sign-in that never returns from Cloudflare is explained after 10 minutes.
  - An unfinished attempt is shown only to the person who made it. Other admins, organization API keys and MCP see the organization's state without the Typeroll user or the Cloudflare accounts that person authorized.
  - New blocker codes, documented in the new [Cloudflare connection troubleshooting](https://typeroll.com/docs/guides/cloudflare-troubleshooting/) guide: `oauth_cancelled`, `state_expired`, `wrong_browser`, `session_expired`, `permissions_missing` (with `missing_permissions`), `no_eligible_account`, `too_many_accounts`, `account_choice_expired`, `pages_access_denied`, `revision_conflict`, `locked_to_account`, `claimed_by_other_organization`, `authorization_revoked`, `provider_unavailable`, `rate_limited`, `publisher_oauth_misconfigured`.
- The Cloudflare card shows the result inside the card with one next action and the steps **Publisher ready → Sign in to Cloudflare → Choose account → Access verified → Connected**. Page-level Cloudflare banners are gone; a reload shows the same explanation. The callback returns with `?cloudflare=<outcome>` (`connected`, `choose`, `action_required`, `sign_in_required`, `retryable_error`, `unavailable`, `state_expired` or `session_expired`) to the Default card or `&hosting_group=<id>` to that Hosting Group's card. A callback after the Typeroll session ended goes to sign-in and back to the card.
- Several authorized accounts are chosen in the card: each account shows whether Cloudflare Pages access was verified or why it cannot be used, the card says why it asks and until when the choice is open, and the one usable account is preselected. Typeroll never chooses among several accounts, because the connected account is claimed for the Organization and reconnects must keep it. One authorized account is connected directly, as before. An account-specific failure on selection keeps the other accounts selectable.
- **Check again** for Cloudflare: on a saved connection it re-verifies authorization renewal, account access, Cloudflare Pages access and granted permissions (`needs_attention` when one fails). Without a connection it reuses the person's consent from the last hour to list and check the accounts again and offer a new 10-minute choice, after an expired choice, a role fix or a passing Cloudflare error. It never connects by itself.
- Fixes in the Cloudflare flow:
  - The Pages access check no longer sends `per_page=1`; it lists Pages projects without list options, like Wrangler's own client. Applies to OAuth, API-token and Hosting Group connections.
  - A token response without `scope` is accepted as the requested scopes (RFC 6749 §5.1) instead of failing.
  - When Cloudflare rejects HTTP Basic client authentication (`invalid_client`), the token request is sent once with `client_secret_post`.
  - Token errors are told apart: an expired or used code, publisher client settings (with the reason, such as a missing refresh-token grant), rate limits and outages.
- New `GET /api/v1/publishing/cloudflare-diagnosis` (`?hosting_group=`, `?recheck=true`) and MCP tool `diagnose_organization_cloudflare_connection` (`hosting_group_id`, `recheck`). Organization API key required. `GET /api/orgs/publishing` returns `cloudflare_diagnosis`; `GET /api/orgs/publishing/hosting-groups` returns `cloudflare_diagnosis` per group and `cloudflare_setup`. Portal route `/api/orgs/publishing/cloudflare/diagnosis` (GET, POST `recheck`).

## Core 0.2.65 / MCP 0.45.49

- Fixed: published sites lost a step's `submit_label` and the form's `allow_back` and `show_progress`; previews showed them, deploys did not.
- Release checks block only on advisories in shipped dependencies (portal, shared, MCP, site template). Documentation-build dependencies are still audited and reported.
- http-cache-semantics 4.3.0 (GHSA-ch52-4w7c-c8xp).
- Opt-in follow-up on abandoned multi-step forms: an email action with `trigger: "partial_abandoned"` and `after_hours` (1–720) is sent once per partial submission that has not advanced for that long, for example to hear about a lead who left after step 1. A newer step resets the wait; completed submissions never send it; previews never store submissions. Each action is claimed on the submission (`abandoned_actions_fired`) before it runs, so it runs at most once even with repeated or concurrent deliveries. The check uses the existing scheduled-work index (`form_partial_abandoned`), delivered by Cloud Tasks, the in-process timer or the `/api/internal/publish-sweep` scheduler, so self-hosted Core needs that scheduler, as for scheduled publishing. Default unchanged: actions run on completion. Available in the API, MCP (`trigger`, `after_hours` on actions), `get_form_capabilities` (`triggers`) and the portal Forms editor (**Send**).
- Multi-step form navigation (render version 5):
  - Per-step button labels: a step's `submit_label` sets its button text on every render version. From render version 5 every step but the last defaults to "Continue" ("Fortsätt" on Swedish sites) and the last keeps `submit_text`. **This changes existing multi-step forms when a site moves to render version 5**; earlier render versions keep `submit_text` on every step.
  - Back navigation: from render version 5 multi-step forms show a "Back" ("Tillbaka") button from the second step (`allow_back`, default on from render version 5; `true` shows it on earlier versions, `false` hides it). It shows the previous step in the browser with the answers kept and sends nothing. Sending an earlier step again names it (`_step`) and updates the same partial submission; a stale or skipped step is refused.
  - Step titles: from render version 5 a step that starts with a `form/heading` block does not also render its `title`. `create_form`/`update_form` (and the REST API) return `warnings` for a step with both, and the portal shows them.
  - Step changes are announced through a polite live region (step heading, with "Step X of Y" when progress is shown); focus still moves to the step's heading or first label. This applies on every render version.
  - Optional progress indicator: `show_progress: true | "text"` shows "Step X of Y" ("Steg X av Y"), `"bar"` a slim bar with the same text for screen readers. Off by default.
  - API, MCP (`create_form`, `update_form`, `read_form`) and the portal Forms editor (Overview → Steps) expose `submit_label`, `allow_back` and `show_progress`. Server-rendered dynamic steps return `step`, `submit_label` and `final` so the runtime can label them.
  - Render version 5 is new; new sites start on it, existing sites keep their version until upgraded. The platform CSS gains rules for the Back button and progress indicator (reference updated for every version; no existing markup uses them).
- Fixed: hidden steps of a multi-step form showed when site CSS set a display on steps (for example `[data-form-step] { display: contents }`), so every step appeared at once. The form shell CSS keeps hidden steps and the hidden dynamic-step container hidden (`display: none !important`). The platform CSS reference changed for every render version; pages without such site CSS render as before.
- Forms work in every preview without setup: the editor's preview, Preview site, preview links, page and revision previews and `get_page_preview`. The forms runtime runs in preview mode: each step is validated with the server's rules and messages, steps advance (dynamic steps included) and the last step shows the success message; a redirect is named ("Preview – would redirect to /tack/") instead of leaving the preview. A "Preview – nothing is sent" notice ("Förhandsvisning – inget skickas" on Swedish sites) marks the form. Nothing is stored and no email, webhook or app action runs. Previews used to post real submissions.
  - Preview forms carry no submit token and post to the core endpoint, which refuses their `_preview` marker (403, also for no-JS posts), so a preview can never create a submission. Only the portal's preview renderer emits preview mode; published pages never contain it.
  - Extension components in previews: `forms.submit()` resolves `{ v: 1, ok: true, done: true, preview: true }` without a request instead of throwing "Extension form submissions are not configured".
  - New template capability `forms_preview_mode` (template capabilities 0.51.0). The `get_page_preview` and `get_preview_link` descriptions and the tr-forms skill describe preview forms.
- Fixed: a multi-step form with a required field after step 1 could not be completed. The browser's own validation also checked the hidden later steps, so sending step 1 failed silently ("An invalid form control is not focusable"). The forms runtime now disables the fields of hidden steps, so native validation and the posted data cover the visible step only, and enables them when their step shows. The server still validates each step's fields. A form with a dynamic step no longer posts every later step twice.
- Visitor-facing form messages follow the site's language (Swedish for `sv`, English otherwise) on the server and in the forms runtime. Previously only validation messages and button defaults did, so a Swedish site showed, for example, "Slow down and try again." (`too_fast`), "Session expired — reload the page." (`bad_state`) and "Too many submissions. Try again later.".
  - Submit endpoint: every error and confirmation message (rate limits, invalid or missing token, form not found, too fast, expired or already sent step, a failed pre-submit check, the honeypot's "Thanks!") and the no-JS confirmation and error pages, which now carry `lang` and a localized title. Refusals sent before the token names the site (payload size, the per-IP limit, a missing or invalid token, previews) follow the request's `Accept-Language`. Machine `code`s, status codes and English message texts are unchanged.
  - Forms runtime: remote-backed forms (prefill or session) carry their messages in the site language as `data-msg-*` attributes ("Wait for the form to load…", the expired link, the retry wait, the work-email hint), so published static pages need no request; the retry wait reads "Try again in 2 hours." instead of "2 hour(s)". Other forms' markup is unchanged. Extension components without an `unavailable_message` fall back to a message in the page's language.
- Hidden form fields named `utm_*` (`utm_source`, `utm_medium`, `utm_campaign`, …) are filled from the same-named parameter in the page address, so `?utm_source=linkedin` is stored with the submission and listed in notification emails. Previously nothing filled them and they were always stored empty. The field's own value is the fallback for visits without the parameter; other hidden fields keep their value. Only the current address is read and nothing is stored in the browser, so no consent is needed; carrying a campaign across pages remains an app's job. Needs JavaScript. New template capability `forms_utm_hidden_fields`.

## Core 0.2.64 / MCP 0.45.48

Connect GitHub can no longer stop without saying what to do next after the App installation.

- Publisher setup: the GitHub App's **Setup URL** must be `{PORTAL_PUBLIC_URL}/api/orgs/publishing/github/callback` with **Redirect on update** selected, and **Request user authorization (OAuth) during installation** stays off. Without the Setup URL, GitHub leaves people on its installation settings page instead of returning them to Typeroll. The setup documentation no longer says the App does not need one.
- A return to the callback with `setup_action` but no matching `state` (installed or updated from GitHub directly, or an installation link older than 10 minutes) records and consumes nothing and never trusts `installation_id`. The card opens with `?github=installation_returned` and checks again, or explains an owner-approval request (`install_requested`).
- The GitHub card checks again by itself when Publishing opens and when its tab regains focus, while the person's GitHub sign-in is less than an hour old and GitHub is not connected yet: at most once per 10 seconds, with the result announced in the card. A reload no longer shows a stale "not installed". While an installation started from Typeroll is pending, the card says "Back from GitHub? We check automatically — or select Check again." `GET /api/orgs/publishing` returns `github_attempt` (`recheck_available`, `installation_started_at`) for this.
- A personal account that is ready on GitHub is connected with **Connect @login** ("GitHub asks you to confirm once; you come straight back here."), and the summary names the step ("Connect @login to finish."). "Sign in to GitHub to connect @login" is shown only when the sign-in is older than an hour. Other summaries name the next step or who must act instead of "One step below is needed."
- Each reason shows **Who acts: …** as its own label above the sentence. "GitHub organization owner @login is not an owner of Moveria-AB" read as one garbled sentence. Reasons no longer lowercase account names ("an owner of Moveria-AB must …").
- New blocker code `setup_url_missing` (`who: publisher`): an installation started from Typeroll found on an account the person owns, but no return to the callback within two minutes. It is a note for publishing admins that links to the App settings and changes neither the outcome nor the next step.

## Core 0.2.63 / MCP 0.45.48

- Form email notifications with "Append all submitted values" (`include_all`) list the values under the field labels shown on the form, in form order, instead of the field names. Choice fields show the chosen option's label, empty hidden fields (such as `utm_*` parameters) are left out and multi-line answers keep their line breaks. Plain-text emails use `Label: value` lines with the same rules. Stored submissions, webhooks and the form and action APIs are unchanged.
- Fixed: a checkbox group with several ticked boxes stored only the last ticked value. A checkbox group's answer is now always the list of ticked values, with or without JavaScript and in the JSON submit API: one ticked box (also when sent as a single string) is stored as a one-item list and no ticked box as an empty list. Other fields keep a single value.
- Fixed: action links in the portal AI chat pointed every changed item to the page editor, so block types and global blocks (header, footer, free blocks) opened a missing page. Each chat action now carries its editor link: "Edit page", "Edit global block", "Edit template" or "Edit block type", and a deleted block type has no link. Saving or discarding a global block's draft is reported as a global block change (`update_partial`) instead of a page change.

## Core 0.2.62 / MCP 0.45.47

Connect GitHub now explains every way it can stop, who must act and how, in the GitHub card, the API and MCP.

- GitHub connection diagnosis:
  - Every exit of the GitHub flow (sign-in callback, installation return, account choice, Check again) stores a diagnosis for 24 hours, bound to the person and the connection revision. It lists every account with the publisher App, whether it can be used, and each blocker with `who` (`you`, `github_owner`, `publisher`, `typeroll_admin`) and one action. No tokens or GitHub responses are stored or returned.
  - An unfinished attempt is shown only to the person who made it. Other admins see the state of a saved connection, and the API and MCP see the organization's state without anyone's GitHub login, other accounts or single sign-on links. One person's failed or cancelled sign-in never marks a working connection as needing attention.
  - A callback is recorded only for the sign-in that the same person started in the same browser, so a link to the callback from another site changes nothing.
  - New blocker codes, documented in the new [GitHub connection troubleshooting](https://typeroll.com/docs/guides/github-troubleshooting/) guide: `not_org_owner`, `membership_unverifiable`, `sso_authorization_required`, `repository_selection_limited`, `permissions_update_pending`, `permissions_missing`, `installation_suspended`, `other_users_personal_account`, `locked_to_account`, `claimed_by_other_organization`, `no_installation`, `install_request_pending`, `oauth_cancelled`, `state_expired`, `session_expired`, `wrong_browser`, `github_unavailable`, `github_rate_limited`, `revision_conflict`, `expiring_tokens_disabled`, `publisher_app_misconfigured`, `encryption_unavailable`.
- Fixes in the GitHub flow:
  - Each installation is checked on its own. Single sign-on, a rate limit or an outage on one organization no longer aborts the others, Members write access is accepted, and a rejected installation no longer changes the reported reason (a missing permission elsewhere used to hide "not an owner").
  - Cancelling on GitHub, an expired or reused sign-in, a return in another browser, an owner-approval request (`setup_action=request`) and GitHub errors each get their own explanation instead of `?github=failed`.
  - A sign-in that returns after the Typeroll session ended goes to sign-in and back to the GitHub card instead of showing raw JSON. Sign-in accepts a same-origin `/app/` return path.
  - Saving the GitHub installation that is already connected is no longer a conflict.
  - Publisher setup reports a missing App and missing encrypted storage separately (`github_setup.app_configured`, `github_setup.encryption_available`, `github_setup.app_slug`).
- After an explicit disconnect, an Organization can connect a different GitHub account once it confirms which account it replaces. Existing repositories are not moved. A GitHub account connected to another Typeroll Organization still cannot be connected.
- Portal: the GitHub card is a five-step guide (publisher ready, signed in as @login, account with the App, access and permissions, connected) with one primary next action, a fix beside each reason and **Check again**. Returning from GitHub focuses and announces the result inside the card; GitHub no longer uses page-level alerts. Cloudflare is unchanged.
- **Check again** (`POST /api/orgs/publishing/github/diagnosis`) re-checks with the publisher App's access and the GitHub identity the same person proved by sign-in within the last hour; after that it asks for a sign-in. It consumes nothing and connects nothing by itself: a usable organization becomes a choice the person confirms within 10 minutes and within the hour of the sign-in, and ownership is verified again before saving. An organization the person names but does not own gets the same answer whether or not the App is installed there.
- Every state of the GitHub card offers a next step that works, including an expired account choice and a request waiting for an organization owner. Opening the App installation no longer interrupts another admin's sign-in in progress, and a renewed personal-account authorization is saved even if the connection changed meanwhile.
- API and MCP:
  - New `GET /api/v1/publishing/github-diagnosis` (`?recheck=true` re-checks a connected installation) and MCP tool `diagnose_organization_github_connection`. Organization API key required.
  - `POST /api/v1/publishing/connections/github` answers 409 with `connect_url` and `diagnosis`.

## Core 0.2.61 / MCP 0.45.46

- Accordions with "Default open" open again: both sanitizers keep the `open` attribute on `<details>` (render version 4).
- The SEO audit workflow audits block pages from their rendered blocks. It read only `html_content`, so every block page was reported as thin content without an H1.

## Core 0.2.60 / MCP 0.45.46

Sites can define their own block types, built from existing blocks or written as markup, and edit them in a visual builder.

- Site block types:
  - Composed types (`composition`) are built from existing blocks. The schema declares the type's fields, and inner blocks bind them as `{{props.title}}`. A repeater without `item_block` renders its children once for each item of a list field (`{{item.title}}`). Composed types can contain other composed types.
  - Template types (`template`) write their own markup. They can loop with `{{#each}}` and `{{@number}}`, test for empty values with `{{^field}}`, and link with `{{#link field class="…"}}`.
  - New `link` field type (`{ page_id?, url?, new_tab? }`). It resolves to a safe `href`, `target` and `rel`, and a link to a page follows when the page's slug changes.
  - A block type's stylesheet is scoped to the block (`:scope`, `css_scope: block`). Page-wide selectors such as `body {}` are refused.
  - Starters: icon list, feature cards and numbered steps.
- One write path for block types in the portal, the API, MCP and the chat:
  - Every write goes through the same validator. Errors refuse the write and list every problem with its JSON path or template line; warnings are returned with the result.
  - New endpoints `validate`, `preview` and `starters` (MCP `validate_block_type`, `preview_block_type`, `list_block_type_starters`). The preview renders an unsaved definition with the site's theme, styles and render version.
  - **Contract change:** creating and updating a block type now responds with `{ block_type, warnings, impact? }` instead of the bare block type.
  - Updates take `renames`, which move the data on every page, draft, template, header, footer, global block and repeater item. An update that removes or retypes fields holding data answers 409 with the affected uses, unless it sends `confirm_data_loss: true`.
  - Usage follows compositions, repeaters, drafts and block templates. A block type cannot be deleted while it is used.
  - `.tcblocks` export and import is lossless and takes `on_conflict`: `skip`, `rename` or `replace`.
  - Only admins can create, change, delete or import block types. The chat writes `script` only when the site allows AI block scripts.
  - On a site below render version 4, the write warns when an icon sits inside a linked container, because the links would nest.
- Portal:
  - A block type builder on the Blocks page, with the tabs Fields, Blocks (with "Bind to field"), Markup, CSS, Preview, Usage and JSON.
  - "Turn into block type…" makes a type from a selected section and replaces the section with an instance of the type. "Detach into blocks" reverses it.
  - In the inspector, list items can be collapsed, reordered by dragging or with Move up and Move down, duplicated and removed with undo. The inspector also gains icon, link and image pickers.
- New `core/text` block: plain text in a chosen element. `core/container` can open its link in a new tab.
- Render version 4:
  - Accordion items render as expandable sections, and "Default open" opens the first item or every item.
  - Pricing plan features and team member social links render, and excluded features are marked.
  - An icon without a link no longer sits in an empty link.
  - A container set to be a link renders as a plain container when it has no address, and so does a team member card without a link.

## Core 0.2.59 / MCP 0.45.45

Everything the portal can do is now available through the authenticated API and MCP, with the same permission checks. The portal chat assistant keeps its narrower tool set.

- Settings and sites:
  - `update_site_settings` takes every field the Settings form takes (`default_og_image`, `twitter_handle`, `organization`, `staging_url`) and, like the form, needs admin.
  - `update_site` sets `ai_scripts_enabled` (admin). API block and block type writes no longer carry a script notice.
  - Archive and restore a site (`archive_site`, `restore_site`), purge an archived site's media (`purge_site_media`), and read upload status (`get_media_upload_status`).
  - The API page preview renders block scripts, the Extension runtime and the cookie banner, like the portal preview.
- Email and forms:
  - Outgoing email provider: `get_email_settings`, `set_email_settings`, `delete_email_settings`, `send_test_email` (admin; secrets are write-only). The portal gains Disconnect.
  - Incoming email through MCP (`get_incoming_email_settings`, `set_incoming_email_forwarding`, `read_incoming_email_receipt`); portal and API share one implementation.
  - `get_form_capabilities` lists core and app-provided action types; `read_form_submission` reads one entry. Admins see webhook delivery status, and deleting submissions removes their delivery records.
- Branches, history and Extensions:
  - `diff_version` and `reset_version`. Creating, merging, deleting and resetting branches needs admin, as in the portal.
  - Partial (header, footer, global block) revisions: list, read, restore. `preview_page_revision` renders an earlier saved state.
  - Install, enable or disable, uninstall, pair, diagnose and launch Extensions; Extension developer tools for organization keys.
- Organization administration and workflows:
  - List and revoke site and organization API keys, share a site and create invites (`list_api_keys`, `revoke_api_key`, `share_site`, `create_organization_invite`, …). A share never reaches further than the caller.
  - New secrets stay in the portal: creating API keys, rotating Extension server credentials and registering an Extension or rotating its client secret are not available through the API or MCP, so a secret never lands in an agent conversation or log.
  - Workflows: start, read and approve (`start_workflow`, `get_workflow`, `approve_workflow`), and `create_site_and_migrate` / `create_site_and_plan`. Rebuild & deploy needs admin; workflow reads no longer expose the WordPress helper key.
  - Organization publishing connections: status, Cloudflare token connect, media storage, disconnect.
- Global blocks:
  - Usage covers page templates, header and footer and other global blocks, saved or in a draft.
  - Detach copies the draft the editor shows when there is one.
  - Block-mode header and footer use the block-tree editor with Save draft / Discard draft.
- End-to-end tests wait for visible UI state instead of network idle.

## Core 0.2.58 / MCP 0.45.44

- Remove HTML-to-blocks conversion. A heuristic conversion cannot reproduce designed pages faithfully.
  - Gone: the page-level conversion preview, the text-block **Convert into blocks** action, their API routes, and the MCP and chat tools `convert_page_to_blocks` and `convert_prose_block`.
  - HTML pages stay HTML. Switching a page to blocks starts an empty block tree and keeps the HTML as a revision; the content is then built with blocks.
- WordPress import keeps its lazy-media clean-up, now in its own module.
- API and MCP can do what the portal can with forms:
  - Read and write a form's email notifications and webhooks (`actions`, admin keys; webhook secrets are masked and kept when unchanged).
  - Docs and agent instructions no longer say notifications are hidden from agents. The portal chat assistant still has no notification or submission tools.
- API keys and MCP write Page fields with the same authority as an editor in the portal. They may write every field open to the portal or agents, and portal, API and MCP edits replace each other; the latest edit wins. Machine passes inside Typeroll (the portal chat assistant, AI workflows) still never replace an editor's value. Replacing a value the listed business set needs `override_reason`, in the portal and the API alike.
- App installation credentials never read or write form actions.
- Render version 3: the theme tokens blocks reference (`--color-bg`, `--color-bg-subtle`, `--color-border`, `--color-secondary-fg`) come from the site palette instead of fixed greys. Versions 1 and 2 render unchanged.
- Update devalue to 5.9.4 for new security advisories.

## Core 0.2.57 / MCP 0.45.43

- Add render versions. Each site keeps its rendering until someone previews and upgrades it in Settings → Rendering or through the API and MCP. New sites start on the latest version, and reference snapshots guard every released version.
- Render version 2:
  - A heading's eyebrow and new subtitle are grouped in `<hgroup>`, take named styles and are never faded.
  - A block's custom class lands on the heading or button link itself.
  - Text on primary-coloured buttons is black or white, whichever reads better.
- Add named styles. Sites get a style library with element roles (body, H1–H6, links) and class styles chosen per block.
  - Values are set per breakpoint, there is a standard set for new sites, and text below WCAG AA contrast is refused.
  - The library is available in the UI, the API and MCP (`list_styles`, `create_style`, `update_style`, `delete_style`, `apply_standard_styles`).
- Improve the text editor:
  - Paragraph styles: Heading 2–4 and the site's text styles.
  - Preview-first conversion of unsupported markup into blocks (`convert_prose_block`).
  - HTML import folds a classed eyebrow or subtitle into its heading.
  - Block writes warn when a heading label is written as a text block.
- Manage site and page CSS with line numbers and live checks. Syntax errors and script-capable CSS are refused; selectors on platform markup produce a warning. Stored CSS can no longer close its `<style>` element.
- Show CSS class and anchor under a block's Advanced settings.
- Add reusable blocks:
  - Global blocks are referenced from block pages (`core/global_block`) and render in place. A section can be made global or detached.
  - Block templates are saved section starters that are copied into a page.
  - Both are available in the UI, the API and MCP.
- Fix low-contrast text in the editor and admin, and keep a block global block's mode when it is saved.

## Core 0.2.56 / MCP 0.45.42

- Make preview match the published page: same head CSS order (template base CSS after site and page CSS), shared theme and webfont fallback rules, and media URLs rewritten for every media id format.
- Search page content in block data, HTML bodies and text fields.
- Let a container render as a link (`tag: a` with a safe `href`) and let headings inherit their container's alignment.
- Add an optional form `success_redirect_url` (path or http(s) URL) and render the success message as sanitized HTML for visitors without JavaScript.
- List, read and restore page revisions through the API and MCP; restore uses the draft path and keeps publication state.
- Point branch documentation at each version's reported `deploy_url`.

## Core 0.2.54 / MCP 0.45.41

- Stop automatic HTML-to-blocks conversion from rewriting a page. Mode switches, agent tools, WordPress import, and the unified Pages migration keep HTML bodies intact.
- Offer the heuristic only as a preview that lists text, classes, and markup it could not convert. A person accepts that preview in the page editor.

## Core 0.2.40 / MCP 0.45.33

- Add provider-independent navigation inputs with same-origin, bounded tab defaults and explicit receiver fields; preserve safe navigation without storage or JavaScript.
- Render accessible mixed service tabs/direct links with responsive disclosure, native presentation controls and working static slots.
- Support decorative missing-thumbnail panels and deliberately compact mobile footer navigation without changing comfortable defaults.
- Document migration discovery, responsive composition and privacy boundaries in public guides and MCP recipes.

## Core 0.2.39 / MCP 0.45.32

- Add a guarded, idempotent Retry verification action in the portal and authenticated API/MCP for timed-out, already-served customer publications.
- Reuse the exact job and artifact; run real public checks and normal CMS finalization without source generation, build dispatch, upload or DNS changes.
- Reject superseded jobs, changed publishing modes, incomplete receipts and unrelated failure types; preserve the original failure and durable retry identity.

## Core 0.2.38 / MCP 0.45.31 unchanged

- Allow retired native image variants on public hosts only when the frozen artifact retains the exact original image bytes. Keep candidate removal checks and checks for deleted or replaced originals.
- Recover already-running publications from older saved probe lists using the full frozen manifest and a new verification-policy checkpoint. No rebuild or manual job reset is required.

## Core 0.2.37 / MCP 0.45.31

- Include full original-width AVIF/WebP candidates in static publishing and explicit media generation, without upscaling or duplicate widths.
- Coordinate v2 immutable variant keys, scoped grants, completion receipts, aliases and preparation state; preserve originals and old public URLs.
- Verify actual encoded dimensions, frozen publication HTML, browser selection and warm-cache reuse.

## Core 0.2.36 / MCP 0.45.30

- Extend recognizable, keyboard-visible text links to native lists, tables, image captions and other rendered rich-text surfaces, preserving interactive card, image, button and navigation styling.
- Verify real frozen output, renderer cache invalidation and mobile/desktop computed styles; document adoption through republication.

## Core 0.2.35 / MCP 0.45.29

- Keep prose text links visibly underlined across theme resets without changing native buttons, cards or navigation.
- Wrap breadcrumb titles continuously while preserving ordered-list semantics.
- Add responsive image framing, fit/aspect and focal controls; keep intrinsic, uncropped defaults.
- Add shared body heading scales and spacing to Page content slots and containers; fix responsive heading alignment.
- Parse original migration HTML with browser tree-construction rules and convert image-only headings in place. Existing content is not rewritten automatically.

## Core 0.2.31 / MCP 0.45.25 unchanged

- Acknowledge SES internal setup notifications after topic, signature and storage
  route verification, without customer alerts, receipts or quota consumption.
  Ordinary mail and lookalike identifiers keep their existing checks.

## Core 0.2.30 / MCP 0.45.25 unchanged

- Allow incoming SES callbacks through portal middleware without a browser Origin.
  Keep exact SNS topic and cryptographic signature verification in the handler;
  neighboring routes and browser settings retain CSRF protection.
- Verify signed notifications and subscription confirmations through the complete
  middleware and route chain before activating incoming email forwarding.

## Unreleased — Core 0.2.28 / MCP 0.45.24

- Add versioned site breakpoint widths with editor/API/MCP parity and exact block
  visibility ranges. Preserve explicit menu and theme thresholds.
- Add native prose typography, container minimum height, short Page breadcrumb
  labels and Post Card action/icon presentation. Fix responsive card media width.
- Advertise template capabilities 0.47.0; existing sites require republication.

## Unreleased — Core 0.2.27 / MCP 0.45.23

- Generate agent-neutral site workspaces with briefs, decisions, QA, non-secret
  Site/Organization/Version bindings and hash-based updates that preserve edits.
- Add read-only workspace diagnostics and optional local client adapters.
- Offer compact MCP discovery with five stable tools, on-demand schemas and
  separate read/write/admin execution. Full mode remains available.
- Add paginated site discovery and section-based guide reads. Document client
  context costs, safe project files and the current CLI/API boundary.

## Unreleased — Core 0.2.26 / MCP 0.45.22

- Require explicit per-installation activation across declared app release boundaries.
- Add scoped idempotent mail receipts, SES delivery events, quotas and suppression;
  keep unknown acceptance out of automatic retries. Receiving mail is not included.
- Retain immutable item identities and keyed provenance in owner descriptors and
  batch API writes. Branch edits cannot mark main for auto-publication.
- Add block-authored menus with optional independent mobile composition, typed
  article-card presentation, and numeric icon sizing. Preserve full content-slot
  width when typography is applied. Strengthen migration coverage requirements.
- Extension runtime 0.42.0 identifies the activation/mail contract; candidate apps
  require it before installation. No customer site is automatically republished.

## Unreleased — Core 0.2.24 / MCP 0.45.20 unchanged

- Accept bounded, valid SEO reports above 8 KiB on authenticated build completion
  and failure callbacks. Keep publishing-account and other runner requests at
  8 KiB; count streamed UTF-8 bytes and preserve artifact/lease validation.
- Report an explicitly rejected oversized diagnostic with a small failure
  callback, so an engine does not appear to lose contact while its error is known.
- Run release source, browser and dependency checks independently. Reuse the
  exact qualified documentation artifact and cached Core image build layers.

## Unreleased — Core 0.2.18 / MCP 0.45.18

- Preserve ordinary URL anchors and their encoding during Extension context
  cleanup unless a fragment parameter was actually consumed. Keep the exported
  helper and generated browser runtime aligned; existing sites need republication.

- Reuse verified media assets already present in the target Pages project before
  downloading originals and variants from R2 in shared Cloudflare/GitHub builds.
- Scope completed upload receipts to each Organization, Site, version and hosting
  target. Recheck availability before upload and fall back to complete local
  output when assets or receipts are unavailable. Preserve atomic deployments.
- Report media reuse and stage timings in build logs; document the first-build
  baseline, independent-build behavior and remaining publication work.

## Unreleased — Core 0.2.8 / MCP 0.45.8

- Reuse immutable per-image completion receipts during publication instead of
  downloading originals, variants and aliases again during preparation.
- Fetch and verify only artifacts required for static output; reuse local files
  across overlapping retained media manifests. Preserve source, path, storage
  and encoder boundaries, bounded grants and interrupted-build recovery.

## Unreleased — Core 0.2.7 / MCP 0.45.7

- Add opt-in article body spacing to Page content slots and editorial starters.
- Keep sticky contents and linked headings below responsive site headers;
  scroll long desktop outlines within the available viewport.
- Add boxed Post Cards for related-article groups using native containers.
- Document template settings and add browser regressions for spacing, header
  clearance and card presentation. Existing sites need republication.

## Unreleased — Core 0.2.4 / MCP 0.45.4

- Split customer publication into durable source, Git and build-dispatch steps.
  Reuse the frozen source during recovery, renew active ownership and enqueue
  scheduled recovery without running builds in the global sweep.
- Capture version content consistently, store snapshot parts with bounded
  concurrency and reuse unchanged per-record Git blobs. Rendering remains full.
- Resolve website/media references in the frozen customer renderer; preserve
  branch identity, media aliases, old renderer snapshots and independent builds.
- Observe waiting builds without reloading source or probing unrelated providers.
  Retry temporary service failures and report safe checkpoint timing metadata.
- Update publishing documentation and API/MCP guidance, including the narrower
  source-only meaning of a customer-publishing dry run.

## Core 0.2.3 / MCP 0.45.3

- Keep article contents in normal flow on mobile while preserving the sticky
  desktop sidebar. Wide tables scroll within columns without widening the page.
- Add browser regression checks for scrolling and layout at mobile and desktop
  widths. Existing static sites need republication to receive the fixed styles.

## Unreleased — Core 0.2.0 / MCP 0.45.0

- Content types define allowed Page templates and default sorting. Pages can
  override the template or inherit it, and edit their manual order through the
  normal Save/Discard flow. Listings and neighbouring-page links share defaults.

- Unify all content as Pages with Content types, custom fields, block bodies,
  shared Page templates, one editor, history, preview and publication flow.
- Remove the old Collections API, tools and runtime storage model. Existing
  installations require the schema 2 migration before starting this Core version.
- Update public guides, API/MCP help, generated agent instructions, site-kit
  checklists and example data for the new model.
- Retain source-site paths, references, branch inheritance, working copies and
  revisions through the one-time migration. No runtime compatibility aliases.

Entries below describe historical releases, including APIs removed in 0.2.0.
They are not instructions for the current model.

## MCP 0.44.49 / Core 0.1.76

- Start media migrations immediately and continue bounded tasks without waiting
  for the scheduled publish sweep. Resume large libraries from durable cursors,
  preserve late uploads and edits, and retry interrupted transfers automatically.
- Show verified copy progress and automatic continuation in Publishing.
- Explain the next shared-build setup action and distinguish choosing an
  existing Cloudflare build token from creating one.

## MCP 0.44.48 / Core 0.1.75

- Keep publisher App authentication failures separate from personal user grant
  renewal. A publisher-side failure does not revoke the stored user grant or
  incorrectly ask the account holder to reconnect.

## MCP 0.44.47 / Core 0.1.74

- Connect personal GitHub accounts alongside organizations through the same
  publisher App, with verified ownership and explicit account selection.
- Create personal site and shared-build repositories using encrypted, renewable
  user authorization. Existing publication, version branches and build dispatch
  continue using installation tokens.
- Serialize token renewal across instances, preserve disconnects, and provide
  an explicit reconnect action when repository authorization expires or is revoked.
- Prepare the generated main branch independently of the account's initial
  default branch, and retain organization publishing compatibility.
- Update Publishing instructions, account labels and public setup documentation.

## MCP 0.43.9 / Core 0.1.17

- Keep sign-out outside the scrolling navigation so it remains visible on
  short mobile screens after adding organization switching.
- Enable organization forms and the selector only after hydration, preventing
  native form submission or lost changes while their JavaScript loads.

## MCP 0.43.8 / Core 0.1.16

- Added browser-session organization switching and multiple memberships per user.
  Creating or joining another organization preserves previous memberships.
- Revalidate selected memberships on every session read, preserve roles when
  joining again, and enforce roles for newly created organizations.
- Keep organization selection separate from Firebase identity claims and clear
  site-version selection when switching or signing out.
- MCP carries the updated Core version contract; no MCP tools have changed.

## MCP 0.43.7 / Core 0.1.15

- Added organization publishing account settings with GitHub App OAuth and
  PKCE, verified GitHub organization ownership, and reusable account claims.
- Added Cloudflare account/Pages checks, R2 upload/readback/cleanup verification,
  encrypted credentials, and revision-protected rotation and disconnect.
- Publishing accounts require an explicit organization owner or admin role,
  including organizations using legacy permissive role settings.
- Site provisioning, editor publication through Git, public media delivery,
  and full portable exports remain under development. MCP carries the updated
  Core contract version; no new MCP tools are introduced in this release.

## MCP 0.43.6 / Core 0.1.14

- Included transitive alias and repeater item CSS/JS in static builds and
  previews, including dependencies in partials and referenced form steps.
  Preview script restrictions still apply to the complete bundle.
- Added content-branch selection to `repair_migration_plain_text`, preserving
  dry-run defaults and forwarding the version to the REST query.
- Added an initial customer-owned Git publishing pilot and an independently
  buildable, frozen HTML-site export. CMS publishing integration, full block
  and module exports, and customer media migration remain under development.

## MCP 0.43.4 / Core 0.1.12

- Made fallback-host provisioning idempotently repairable by resubmitting the
  current site slug when its Pages project or DNS coordinates are missing.
- Made the permanent E2E site domain-neutral, preserved its provisioned hosting
  across reseeds, and required the Cloud qualification journey to repair and
  verify its exact fallback origin before publishing.

## MCP 0.43.3 / Core 0.1.11

- Hosted static site builds now add a host-scoped `X-Robots-Tag` rule for the
  platform fallback namespace through Cloudflare Pages `_headers`. Customer
  domains remain indexable, DNS-only fallback CNAMEs remain supported, and no
  zone-wide Transform Rule or Pages Function is required.

## MCP 0.43.2 / Core 0.1.10

- Self-host runtime convergence now routes all traffic to each newly deployed
  Cloud Run revision, including installations whose previous serving revision
  retained a release tag.

## MCP 0.43.1 / Core 0.1.9

- Added site-wide noindex configuration and indexing diagnostics across the
  settings UI, v1 API, MCP, previews, builds, and migration checks.
- Added a fail-closed migration launch report with URL, SEO, extension, form,
  provider, deployment, and indexing evidence.
- Rejected inert top-level responsive block data recursively and restored the
  native cookie-consent banner in hosted previews.
- Serialized Core, MCP, public documentation, and immutable manifest
  publication into one ordered OSS release train.

## MCP 0.43.0 / Core 0.1.8

- Added exact typed context bindings for native text, URL, image, file, and
  email block fields, plus field-aware collection body, image, and date blocks.
- Added server-rendered page/item breadcrumbs and heading outlines with stable
  IDs, explicit item-navigation field overrides, and stronger responsive,
  focus, overflow, and empty-state defaults.
- Bundled nested `style_overrides.custom_css` consistently in previews and
  static builds.
- Added native article/checklist collection presets to the portal, v1 API, and
  MCP, with blocks-first documentation.
- Page PATCH and batch-write now reject `content_mode` with a pointer to the
  revision-aware mode endpoint instead of silently ignoring it.
- Migration readiness can review proposed compositions and report native block,
  field, capability, business-specific, and workaround dependencies before any
  content is written.
- Added reusable native header, footer, and archive compositions with semantic
  navigation, responsive disclosure, configurable post-card field mappings,
  independent download actions, and omission of empty media markup.
- Added revision-safe partial mode switching and API/MCP access to native
  cookie-consent settings.
- Versioned previews now inherit block types, page templates, collections, and
  items from the base chain, show unresolved block dependencies visibly, and
  static builds fail instead of silently dropping an unknown block.
- Form shells now include transitive field-block styles, and responsive field
  objects are verified end-to-end while unsupported top-level responsive data
  is rejected explicitly.

## MCP 0.42.2 / Core 0.1.7

- Preserve every discovered trailing-slash spelling during migration URL
  verification, and emit slash-equivalent redirect variants in static builds
  without changing stored redirect rules.
- Normalize WordPress titles, excerpts, SEO text, and site metadata as plain
  text during new imports by decoding exactly one entity layer and removing
  markup.
- Add an authenticated, dry-run-first repair operation for legacy WordPress
  plain-text fields, with exact diffs, field and schema allowlists, working-copy
  conflict protection, and matching MCP guidance.

## MCP 0.42.1 / Core 0.1.6

- Replaced OAuth authorization JWTs with opaque, single-use codes and encrypted
  server-side grants. Codes issued before this update must be requested again;
  existing access and refresh tokens remain compatible.
- Restricted MCP media imports to public HTTP(S) destinations, with pinned DNS
  resolution, redirect validation, and bounded downloads.
- Reject sessions when Firebase revocation checks fail, including disabled or
  deleted accounts.
- Reserve unique site IDs atomically before provisioning to preserve existing
  sites when names collide.
- Reject replayed or concurrent form steps without changing completed submissions
  or repeating their actions.
- Repair organization claims when retrying an interrupted invitation acceptance.

## 0.42.0

- Added `typeroll extension configure` for API-key-authenticated installation
  config changes from an Extension repository.
- Extension config updates through the CLI and MCP now queue a production
  deploy by default, with explicit opt-outs for batching changes.
- Expanded the Extension documentation for installation config, labelled enum
  fields, preview route allowlists, secret preservation, and redeploy behavior.

## 0.41.1

- Fixed preview bridge origin binding behind TLS-terminating proxies and made
  bridge timeouts visible to Extension code instead of silently attempting a
  blocked iframe navigation.
- Documented that origin- or referrer-restricted third-party browser keys need
  a separate preview-safe configuration for the portal preview origin.

## 0.41.0

- Added `context.site.url()` and `context.site.navigate()` so Extension flows
  can move between site pages without escaping a signed preview.
- Added installation-scoped `context.storage.session` and
  `context.storage.local`. Published sites use Web Storage; opaque preview
  frames use a source-bound parent bridge with tab-session lifetime, keeping
  private handoff data out of URLs, referrers, generated HTML, and requests.
- Added explicit site-navigation and storage capability flags.

## 0.40.1

- Fixed `<x-extension>` expansion inside HTML header and footer partials,
  including the 404 build path and cache key that previously allowed raw
  directives to reach deployed output.
- Added a dedicated capability flag for Extension directives in HTML partials.

## 0.40.0

- Added authenticated REST and MCP operations for reading and updating
  Extension installation config, with an explicit redeploy-required result.
- Added migration inventory imports, URL verification, internal-link checks,
  safer batch operations, and the corresponding MCP tools and skills.

## 0.39.0

- Added safe navigable Extension previews with short-lived preview proofs and
  route-level `preview_methods` allowlists enforced by both runtime and
  provider contracts.
- Added localized `enum_labels`, richer nested prop editing, URL pickers, and
  more precise site capability discovery.

## MCP 0.38.1 — 2026-08-26

- Extension publishing and iframe runtime hardening, with CLI regression tests
  and reference architecture documentation (tag `mcp-v0.38.1`, source `1143579c`).
- This historical entry records the standalone MCP release; current Core and
  MCP version numbers are tracked independently in the release entries above.

## 0.38.0

- Standardized the product and protocol name on **Extensions**. Manifest
  schema v3, runtime 0.38 and host protocol 3 replace the short-lived
  Connector terminology with `ExtensionInstallation`, `public_extension` and
  `X-Typeroll-Extension-Token` throughout the public contract.

## 0.37.0

- Replaced the Extension gateway with the manifest v2 direct provider API
  contract. Browser components call developer-owned backends directly and can
  attach a short-lived, origin-bound installation JWT without proxying payloads
  through Typeroll or customer hosting.
- Kept customer site deployments static: Extension, Forms and Directory calls
  no longer generate Cloudflare Pages Functions. Forms use the owning hosted or
  self-hosted Forms endpoint directly.
- Defined Typeroll Apps as the separately sold premium collection operated
  only in Typeroll-controlled accounts, including for self-hosted CMS users;
  third-party and bespoke backends remain in their developers' accounts.
- Moved hosted fallback-domain indexing protection out of customer deploys and
  into a single `*.sites.typeroll.com` zone-level edge rule.

## 0.36.0

- Added least-privilege Extension form bindings and the
  `context.forms.submit()` runtime capability for native lead tools.
- Extension assets remain hash-pinned and are vendored under the customer
  domain; bound form submissions use a narrow same-origin proxy that does not
  forward customer cookies or authorization.

## 0.35.0

- Added the Typeroll Extension platform for private, unlisted and reviewed
  public extensions: immutable manifests, scoped installations, developer and
  site-admin surfaces, delegated admin SSO, lifecycle events and diagnostics.
- Added hash-pinned bundled components and sandboxed embedded apps, including
  opaque-origin editor preview, public build snapshots and a Cloudflare Pages
  gateway adapter with signed installation assertions.
- Added declared URL context and per-mount memory navigation for recipient
  links, plus server-expanded `<x-extension>` references for HTML-mode pages.
- Added self-hosted issuer discovery/JWKS and explicit provider trust pairing.
- Added the `typeroll extension` developer CLI for validation, draft push,
  test installation and promotion through the same APIs as the portal.

## 0.34.0

- Added server-expanded `<x-form id="…" />` references for HTML-mode pages;
  they use the same signed form shell and initial state as `core/form` blocks.
- Added a portal field builder for ordinary single-step forms and a native URL
  field block.
- Added admin-only, allowlisted form webhooks with encrypted signing secrets,
  HMAC/idempotency headers, transient retries, and delivery status in the
  submissions inbox.
- Wired pre-submit action vetoes into the standard stored-submission pipeline
  and removed admin action configuration from agent APIs and build snapshots.

## 0.33.0

- Added the opt-in Funnel attribution app: validated allowlisted query
  forwarding to exact HTTPS link targets, non-blocking analytics events, and
  optional consent-gated first-/last-touch cookies.
- Added admin UI, bearer API, and MCP configuration surfaces for funnel rules.
- Added private DevGlow + Tailscale Serve development instructions.

Notable changes to the Typeroll platform and the `@typeroll/mcp-server` npm
package, which are versioned together — the platform's
`template_capabilities_version` always matches the published npm version, so an
agent can call `get_site_capabilities` and know exactly what a deployment
supports.

Entries focus on what changes for **users, agents, and self-hosters**: breaking
changes first, then what's new, then fixes worth knowing about. Internal
refactors are omitted unless they alter observable behaviour.

Versions before 0.29.0 predate this file; see the git history and the
`mcp-v*` tags.

---

## 0.32.0

Migration tooling for moving a whole family of sites — a WordPress multisite,
or a set of country/language domains — without losing URLs, plus the hreflang
field that a multi-domain family needs.

### Added

**The URL inventory is reachable over the API and MCP.** The legacy-URL
inventory and its coverage analyser existed since the WordPress migration
shipped, but only behind the cookie-authed portal dashboard, and only the
migration workflow could populate it. Both limits are gone:

- `GET /api/v1/sites/{id}/migration-urls` — the inventory with a **live**
  coverage status per entry (`migrated` / `redirected` / `excluded` /
  `unhandled`), recomputed from current pages + redirects on every read.
  Filterable by status; the summary always describes the whole inventory, not
  the page you asked for.
- `POST /api/v1/sites/{id}/migration-urls` — bulk add (up to 2000 per call)
  from a sitemap walk, a Search Console export (pass `gsc_clicks` and the work
  list prioritises itself), or a crawl. Idempotent. `source_origin` rejects
  foreign-origin URLs, which is what stops one market's `/kontakt` registering
  as another market's coverage in a multi-domain migration — rejects are
  reported, never silent.
- `PATCH` / `DELETE /api/v1/sites/{id}/migration-urls/{urlId}` — `excluded` is
  the record that a URL is _meant_ to 404, which is what separates "not looked
  at" from "decided".
- MCP: `list_migration_urls`, `add_migration_urls`, `update_migration_url`,
  `delete_migration_url`.

**Pre-cutover URL parity check.** Coverage analysis is a claim about the data;
this is a measurement of the server. `POST /api/v1/sites/{id}/migration-urls/verify`
(MCP: `verify_migration_urls`, or the new **URL parity check** workflow in the
portal) requests every inventory URL against the deployed site and classifies
what came back: `ok`, `ok_redirect`, `missing`, `broken_redirect`, `error`. It
catches what coverage cannot — a redirect pointing at an unpublished page, a
typo'd `path`, a redirect loop — all of which read as handled in the report and
as a 404 to Googlebot.

It runs against the site's **fallback subdomain** by default, i.e. while the
real domain still points at the old host. That's the point: find and close the
gaps with the old site still serving, then move DNS.

Redirect rules exercised by a run get `verified` + `last_checked` stamped on
them. Those two fields have been in the data model since redirects shipped and
nothing wrote them.

**`Page.alternates` — hreflang for cross-domain language clusters.** A Typeroll
site owns one domain, so `example.se` / `example.de` / `example.co.uk` is three
sites and nothing can derive which page matches which. Declare it per page and
the renderer emits `<link rel="alternate" hreflang>` in `<head>`, injecting the
page's own self-reference (Google drops clusters whose members don't list
themselves). Writable from v1 REST (`create_page`, `PATCH`/`PUT`, `batch-write`)
and MCP (`create_page`, `update_page`). Invalid tags or non-absolute hrefs are
**rejected at write time with the reason** rather than dropped silently at
render. Capability flag: `supports_hreflang_alternates`.

**`tr-migrate-multisite` skill** — the recipe for the whole job: one site per
domain, per-site inventory before any building, one reference site approved
then replicated via `.tcblocks`, path preservation, redirects, hreflang written
on all sides, and the parity check as the gate on cutover.

**Migration preflight.** `GET /api/v1/sites/{id}/migration-preflight` (MCP:
`get_migration_readiness`) answers "is this site ready to receive an import?"
before any content moves, and the in-portal migration workflow now runs the
same check as its **first step** and refuses to start when a blocker stands
(`skip_preflight: true` overrides, and logs that it did).

Every check exists because its failure is invisible after the fact — the
import succeeds, previews render, the customer signs off:

- **Media storage (blocker).** Without R2 configured, imported pages keep
  their original image URLs: the new site looks perfect and is still served
  images by the old host. Nothing appears broken until that hosting is
  cancelled, months later, when every image breaks at once.
- **Hosting adapter (blocker).** Without Cloudflare credentials, deploys run
  against the stub adapter — a job id, no publish, and a green result.
- **Source site (blocker, when you name one).** Pass `source_url` and the site
  being migrated FROM is probed too: unreachable, or 403/429 from bot
  protection, blocks — an import from a host that refuses our requests
  produces empty pages, or pages containing the block page, which reads as
  real content. Whether `/wp-json` answers is a warning, since the importer
  can fall back to scraping (losing ACF/custom fields).
- Warnings for the pre-cutover verification URL, AI reconstruction, form
  notification email (only once the site actually has a form), and whether the
  target carries a design for the content to be rebuilt into.

The migration dashboard shows the report above the coverage table, because a
blocker invalidates the numbers below it: a site can reach 100% URL coverage
while still serving every image from the host it is migrating away from.

**Redirect wildcards.** `from_path` accepts a trailing `*` (with `:splat` in
the target) and `:name` placeholders matching one segment, so a WordPress
migration retires whole URL families in one rule each —
`/category/*` → `/blogg/:splat` — instead of one rule per URL the inventory
happened to find. Available from the portal's redirect form, v1 REST, MCP
(`create_redirect`) and the chat AI.

Three refusals, all at write time rather than in production:

- a `*` anywhere but the end (Cloudflare drops such a line silently, so the
  rule would read as saved and do nothing);
- `:splat`/`:name` in a target that `from_path` doesn't declare;
- **any rule that would hide a live page**, naming the pages it would hide.
  Redirects are applied before static files, so `/blogg/*` makes every real
  article under `/blogg/` unreachable. The deploy keeps its belt-and-braces
  drop for pages published after the rule was written.

`_redirects` is now emitted most-specific-first, so `/blogg/recept/*` and
`/blogg/*` coexist with the narrower rule winning, and the coverage report
counts pattern-covered URLs as `redirected` — the same order production uses.
Query strings still can't be matched: `_redirects` keys on the path, so an old
`/?p=123` URL has to be handled at the source. Capability flag:
`supports_redirect_wildcards`.

### Fixed

- `og:locale` now follows a page's `language` override instead of always using
  the site default — it already diverged from `<html lang>`, which honoured the
  page.

---

## 0.31.0

Ships the directory app and the platform primitives under it, plus the
`Site.status` removal and build-cost accounting that were staged as 0.30.0.
**0.30.0 was never published** — it was folded in here rather than released
separately, so npm goes 0.29.0 → 0.31.0.

### Breaking

**`Site.status` is removed.** The field was a site lifecycle label
(`'planning' | 'migrating' | 'staging' | 'live' | 'paused'`) that was written
once when a site was created and never advanced afterwards. `'live'`,
`'staging'` and `'paused'` were unreachable in practice, so every site
reported `'planning'` forever — including sites serving production traffic on
a verified custom domain.

- **REST API:** `POST /api/v1/sites` no longer returns `status` in the created
  site object. `GET /api/v1/sites` and `GET /api/v1/sites/{id}` never included
  it, so they are unaffected.
- **MCP:** no tool ever exposed the field. Agents need no changes.
- **Stored data:** existing Firestore documents keep the field. Nothing reads
  it; no migration is required.

**What to use instead.** For "is this site actually serving?", read
`domain_status` (maintained by the domain lifecycle) or the `urls.production`
value from `get_site` — non-null means the domain is verified and serving. For
"has anything been published?", read the deploy history via `list_deploys`.

The portal now shows a domain-derived badge everywhere the old status appeared
(dashboard site cards, site overview, site switcher):

| Badge         | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `live`        | `domain_status` is `verified` or `live` — the site answers on its own domain |
| `DNS pending` | a domain is set, but DNS isn't confirmed yet                                 |
| `DNS failed`  | the DNS check failed — previously hidden                                     |
| `no domain`   | no custom domain set; the site serves on its Typeroll subdomain              |

### Added

**Build-cost accounting.** Every deploy now records what the build cost the
platform to run, on the deploy job itself. `get_deploy_status` returns a `cost`
object with the total, a CPU/memory/request breakdown, wall-clock duration,
per-phase timings, and the size of the generated site. Failed builds are costed
too — they consume the same compute as successful ones.

Costs are **estimates** computed from a configurable rate card, not billing
records, and they are gross: free-tier allowances and committed-use discounts
are not deducted. Self-hosters can retune or zero out the rates with the
`DEPLOY_COST_*` environment variables — see
[Self-Hosting](https://typeroll.com/docs/guides/self-hosting/).

### Added — the directory app

A directory site is a collection with per-item routes, listing pages and
taxonomy pages, where the businesses listed can maintain their own entries.
Most of what landed is general platform machinery the directory is simply the
first consumer of.

- **One-time edit links.** A listing owner requests a link, receives it at the
  address already on their listing, and edits their own entry — no account, no
  password. The link works once and expires.
- **Per-field write authority + provenance.** `writable_by` decides who may
  write a field; provenance decides who wins when several may
  (`portal > owner > app > agent > import`). A refused write is a **409 naming
  the losing fields**, never a silent no-op — a silent drop makes an agent
  retry forever.
- **Item references and computed backlinks** — forward stored, reverse derived.
- **Taxonomy pages** with a `min_items` guard, and combination pages
  enumerated explicitly rather than as a cartesian product. The limit that
  bites on a directory build is route count, not record count.
- **Completeness report** (`collection_completeness`) — the entry point for an
  agent-directed enrichment pass.
- **`core/embed`** — per-page JavaScript with a declared home, so the
  sanitizer never has to be the way in.
- **Integrations app** — 20 third-party tags configured from validated IDs
  rather than pasted script blobs.
- **Apps can ship forms and blocks**; form actions and prefill compose across
  sources.
- **Org member roles are enforced** (`MemberRole`), opt-in per org via
  `Organization.roles_enforced`.
- **Coalesced auto-deploy**, opt-in per site via `Site.auto_deploy.enabled`,
  debounced (15 min default) and folded into the existing publish sweep rather
  than a second scheduler.

Both new flags default to **off**, so nothing changes for existing sites on
upgrade.

### Security

- **Preview responses that render customer HTML on the portal origin are now
  sandboxed** into an opaque origin (`Content-Security-Policy: sandbox`
  without `allow-same-origin`). The sanitizer already strips `<script>`; this
  is defence in depth, because a sanitizer bypass on that origin would be a
  session compromise rather than a defaced preview. The editor's own iframe
  routes are a documented exception — they need same-origin DOM access — and
  the editor canvas does not execute block JavaScript.
- **Executable block-instance fields are gated** behind
  `BlockType.script_fields`.

---

## 0.29.0 — 2026-07-25

### Breaking

**Forms are steps-only.** Form definitions are now stored as `steps[]`. The
Forms 1.0 flat `fields[]` array is gone as a storage shape, but remains
accepted on write as sugar — passing `fields` still creates a single-step form,
so existing agent prompts keep working. Reads always return `steps`.

### Added

- **Typeroll apps** — an opt-in per-site extension framework, with privacy-
  friendly **Analytics** as the first app (Cloudflare Web Analytics, including
  a breakdown of visits arriving from AI assistants). Off by default; enabled
  per site by an admin in the portal under Settings → Apps.
- **Site search** — the `core/search` block indexes the built site with
  Pagefind at deploy time. Add the block and search works; no configuration.
- **Scheduled publishing** — `publish_at` / `unpublish_at` on pages and
  collection items, swept automatically, with a deploy triggered on change.
- **Archive pagination** — collections paginate to `/page/N/` routes.
- **`llms.txt`** — generated at build time so AI assistants can discover a
  site's structure and content.
- **Content export** — download a site's full content as JSON, from the portal
  or via API.
- **Editor** — inline on-canvas text editing, undo/redo (`⌘Z` / `⇧⌘Z`), block
  duplication (`⌘D`), and a visual review of unsaved changes before saving.
- **`core/feature_row`** — a gutter-hugging image + text section block.
- **Media integrity validation** at finalize (SHA-256 verification and a guard
  against truncated SVG uploads).

### Fixed

- **Scripted blocks were dead on deployed sites.** The block runtime's
  initialisation selector was never stamped onto the rendered markup, so custom
  block JavaScript ran in the editor preview but never on the published site.
