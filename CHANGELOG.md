# Changelog

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

## 0.32.0 — unreleased

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
  the record that a URL is *meant* to 404, which is what separates "not looked
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

## 0.31.0 — unreleased

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

| Badge | Meaning |
| --- | --- |
| `live` | `domain_status` is `verified` or `live` — the site answers on its own domain |
| `DNS pending` | a domain is set, but DNS isn't confirmed yet |
| `DNS failed` | the DNS check failed — previously hidden |
| `no domain` | no custom domain set; the site serves on its Typeroll subdomain |

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
[Self-Hosting](https://docs.typeroll.com/guides/self-hosting/).

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
