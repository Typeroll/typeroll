# Typeroll Extensions

Extensions let an external repository add frontend blocks and external admin
pages to a Typeroll site while its business functions and data remain in the
provider's GCP, AWS, Vercel or other environment. The same protocol supports
multi-tenant SaaS extensions and one-customer bespoke systems.

## Development flow

1. Open **Developer → Extensions**, register a namespaced id and copy the
   one-time client secret.
2. Create a v3 manifest using
   [`typeroll-extension-manifest-v3.schema.json`](specs/typeroll-extension-manifest-v3.schema.json).
3. Serve immutable bundle assets over HTTPS and put their SHA-256 hashes in
   the manifest.
4. Save a draft and install it on a site owned by the developer organization.
   Private/unlisted releases publish directly; public releases enter the hosted
   review queue. Customer organizations can only install published versions.
5. Open a site's **Settings → Extensions**, review scopes and data handling,
   then install. Typeroll provisions the declared block types and admin nav.
6. Deploy the site. The build vendors bundle bytes; the component calls its
   provider API directly, without a Typeroll or customer-hosted proxy.

## Installation and release policy

An installation is a timeless trust relationship with an Extension ID, not a
permanent pin to one release. The version selected during installation is kept
as history. At runtime Typeroll selects the newest published release that is
compatible with the installed Extension runtime and the site's stored
configuration.

The installation's `granted_scopes` are the security boundary and never expand
when a developer publishes a release. A newer manifest may declare additional
permissions, but the Extension does not receive them until a site administrator
explicitly changes the installation grant. Existing launch tokens, service
credentials and public Extension tokens continue to use only the approved
scope set.

Extension developers must keep releases backward compatible with existing
component IDs, props and provider data. Breaking products should use a new
Extension ID. If no compatible published release exists, Typeroll omits that
Extension and reports it as unavailable; the rest of the site still builds.

See the runnable contract fixture in [`examples/quote-extension`](../examples/quote-extension/README.md).

The npm package `@typeroll/mcp-server` also installs the `typeroll` developer
CLI. It reads `TYPEROLL_API_URL` and an organization-scoped
`TYPEROLL_API_KEY` and supports `extension validate`, `push --draft`,
`install --site`, `configure --site --installation --config`, and `promote`.
The CLI calls the same APIs as the portal; the server remains authoritative
for full validation.

Site automation can read and update an installed Extension through
`GET/PATCH /api/v1/sites/{siteId}/extensions/{installationId}`. The matching
MCP flow is `list_extension_installations` → `read_extension_installation` →
`update_extension_installation_config`. A successful update returns
`redeploy_required: true`. The CLI and MCP config commands queue a production
deploy by default so the new build-time config becomes visible. Use
`--no-deploy` in the CLI or `deploy: false` in MCP only when batching changes;
then trigger one deploy after the final update.

Every other installation action in the portal is also available to a site
administrator API key and MCP: install, enable/disable, uninstall,
diagnostics, issuer pairing, provider connection and admin-page launch grants
(`install_extension`, `set_extension_installation_status`,
`uninstall_extension`, `read_extension_diagnostics`, `pair_extension_issuer`,
`connect_extension`, `launch_extension_admin_page`). Actions that show a new
secret (rotating the server credential) stay in the portal; a provider that
declares `auth.provisioning_url` receives its credential from Typeroll directly
instead (see the backend guide). The developer API the CLI uses is exposed as
MCP tools for organization-scoped keys (`list_developer_extensions`,
`read_developer_extension`, `update_developer_extension`,
`save_extension_version`, `publish_extension_version`,
`set_extension_version_lifecycle`, `list_developer_extension_installations`);
registering an Extension and rotating its client secret stay in the portal and
the CLI.
Routes are listed in [`v1-api.md`](./v1-api.md#extension-installation-lifecycle).

## Frontend contract

A bundled component exports:

```js
export async function mount(element, props, context) {}
```

`context` contains protocol/runtime versions, installation/component ids,
public config, the declared URL-context accessor, an in-memory navigation
object, site navigation, installation-scoped JSON storage, `api.fetch()`,
`handoff` (runtime 0.43.0+), and `preview` (`true` only in an isolated
preview).
Navigation is per mount:

```js
context.navigation.subscribe(render);
context.navigation.navigate('confirmation');
```

This changes the Extension's internal view without changing the Typeroll page
path. URL context captured when the block mounted remains in its closure. A
reload starts a new provider/customer session; it does not require multiple
Typeroll pages.

Cross-page flows use root-relative site navigation and runtime-managed storage:

```js
context.storage.session.set('quote-draft', { from, to });
context.site.navigate('/flyttfirmeoffert/');
```

`context.site.url(path)` returns an absolute URL on the deployed site and a
token-preserving preview URL in a navigable preview. It rejects external and
non-root-relative paths. `storage.session` and `storage.local` expose
`get(key)`, `set(key, JSONValue)`, and `remove(key)`, namespaced by installation.
Published sites use Web Storage. Opaque-origin previews use storage scoped to
the current preview tab; both preview areas have tab-session lifetime and
survive `context.site.navigate()` without putting values in URLs or requests.

A component that receives visitors from a native `core/navigation_form`
banner reads what they typed with `await context.handoff.read()`. It resolves
`{ key, source: "navigation_form", values, parts }` or `null`; `values` holds
the flat field values (including address parts such as
`address_from_postal_code`) and `parts` groups the parts per field. Access
needs three things: the component declares `page_handoff: true`, the
installation is granted `page_handoff:read`, and the page author binds the
block instance to the banner's defaults key (`page_handoff_key`). The host
checks the handoff's target page and expiry, takes it out of tab storage once
per page load (like a native receiving form), and reads it through the preview
shell bridge in previews. The storage key and packet format stay private to
Core. Embedded apps use `typeroll.extension.handoff.read` /
`typeroll.extension.handoff.result`.

Embedded apps receive `typeroll.extension.init` with protocol version,
installation/component ids, props, public config, URL context and current
navigation state. They may request resize and internal navigation with the
versioned postMessage messages implemented in the shared runtime.

The same installed component can be mounted in HTML mode without copying
provider scripts into page HTML:

```html
<x-extension
  block="extension--install-abc--calculator"
  props='{"heading":"Your quote"}'
/>
```

The `block` value is the provisioned block type id shown by Typeroll. During
preview/build, Typeroll replaces this authoring directive with an inert mount
shell and public initial props. The directive and props are not a second
runtime or an executable shortcode. URL tokens are captured later in the
visitor's browser and are never serialized into the generated shell.

### Recipient links

Declare only the inputs the component needs:

```json
{
  "url_context": {
    "query": [{
      "name": "quote",
      "expose_as": "quote_token",
      "sensitive": true,
      "consume": true,
      "max_length": 256,
      "pattern": "^[A-Za-z0-9_-]+$"
    }]
  }
}
```

The provider creates and emails the token. Typeroll treats it as opaque,
captures it before any component mounts, removes consumed representations in
one `history.replaceState`, and passes only declared values. The provider must
validate expiry, revocation, recipient/action scope and replay behavior.

Core 0.2.18 preserves ordinary URL fragments exactly when cleanup consumes no
fragment parameter. For example, removing `?quote=token` must leave `#details`
unchanged, not rewrite it to `#details=`. The exported cleanup helper and browser
runtime follow the same rule. Consumed fragment parameters are removed while
retaining the other parameters. Existing static sites need republication to pick
up the corrected runtime.

The block editor's **URL context** action sets synthetic string values for the
live preview only. They are sent directly to the isolated canvas and never
stored in page block data.

### Editable component props

`props_schema` is also the editor contract. Primitive arrays render as a
line-based list; arrays whose `items.type` is `object` render as repeatable
nested field groups; URL fields include a picker for the site's own pages.
For an enum, keep the stored values stable and supply optional localized
labels with `enum_labels` in matching order:

```json
{
  "type": "string",
  "enum": ["private", "business"],
  "enum_labels": ["Privatperson", "Företag"]
}
```

The validator rejects `enum_labels` unless it is a string array with exactly
the same length as `enum`.

## App contracts

Runtime 0.46.0 adds app contracts for official apps (the decision record is
[app contracts and live updates](plans/app-contracts-and-live-updates.md)).
An app with a contract is updated without publishing sites: the published page
holds only a mount that never changes within the contract, the component loads
from the contract's stable address, and the app's default markup is written
into the mount at every build. Apps without `contract` keep the behaviour
described above unchanged.

### Trusted developers

Only developer organizations named in the host setting
`TYPEROLL_TRUSTED_APP_DEVELOPER_ORGS` (comma-separated organization ids) may
save or publish a manifest with `contract` (`403 contract_developer_untrusted`
otherwise). The list is also checked whenever a release is resolved: a contract
release of an organization that leaves the list stops running everywhere (the
installation is reported as having no compatible release). An empty or missing
setting allows no contract at all. A contract component runs the app's code and
markup on every site without a publication, and its default markup is not
filtered, which is why this is a host decision and not a manifest field.

### Manifest

```json
{
  "contract": 1,
  "permissions": [
    { "scope": "content:read", "reason": "Reads event pages." },
    { "scope": "email:send", "reason": "Optional reminders.", "optional": true }
  ],
  "api": { "base_url": "https://events-production-c1.example.workers.dev/v1", "routes": [] },
  "frontend": { "components": [{
    "id": "next-occurrence",
    "label": "Next occurrence",
    "render_mode": "contract_component",
    "entry": { "module_url": "https://events-production-c1.example.workers.dev/v1/next-occurrence.js" },
    "variants": { "path": "/variants" },
    "default_markup": { "path": "/default-markup" }
  }] }
}
```

- `contract`: an integer ≥ 1; requires `api.base_url`, the contract's stable
  address. Forms, build derivations, the variants and default-markup calls and
  `context.api` all use it.
- `render_mode: "contract_component"` requires `contract`. `entry.module_url`
  is an HTTPS ES module that always exports the current release's `mount`; it
  has no digest (serve immutable, content-hashed files behind it) and its origin
  must be a registered execution origin. It is optional: a component without it
  is static, nothing loads in the browser and its default markup is the whole
  component. Contract components have no `props_schema` and no `page_handoff`.
- `variants` and `default_markup`: optional `{ "path" }` below `api.base_url`.
- `permissions[].optional: true` (contract manifests only): the app works
  without the scope. It is never granted on install; a site administrator turns
  it on later with the ordinary grant update (`PATCH
  /extensions/{installationId}` with `granted_scopes`).

Publishing a release checks it against the earlier published releases of the
same contract and refuses (`409 contract_broken`) one that removes a component
or requires a permission the contract did not require. Such a change is a new
contract.

### Installation and resolution

An installation stores the `contract` of the release it was installed with.
Runtime resolution picks the newest published release with that contract,
automatically; `activation_policy` does not apply within a contract. A release
with a different contract (including the first contract for an installation
made before the app had one) is reported as `pending_activation_version`, and
moving to it with `PATCH /extensions/{installationId}` and `version` (MCP
`activate_extension_release`) is the only explicit activation; asking for
another release of the same contract is refused. `GET /extensions/self`
returns `contract` (`null` without one) next to `version` and
`published_version`.

Every proof Core signs for a contract installation carries a `contract`
claim next to `version`, which stays the resolved release: the installation
assertions (form actions and options, build derivation, documentation,
`component_variants`, `default_markup`), the credential provisioning
assertion, admin launch and native admin tokens, and public browser tokens.
Installations without a contract get no `contract` claim. One contract address
serves every installation of the contract, so use the claim (not the URL) to
tell which contract a request belongs to.

### Variants

The block type of a contract component has a `variant` field (default
`standard`) and an optional `reserve_px`, never props. The app decides which
variants exist and holds their settings, so a variant changed in the app is
live on every page that uses it. Core asks the app server side:

```http
POST {api.base_url}{variants.path}
Authorization: Bearer <assertion, token_use "component_variants">

{ "component_id": "next-occurrence" }
→ { "variants": [{ "id": "lunch-talks", "label": "Lunch talks" }] }
```

Variant ids match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`; an invalid or missing
id renders `standard`. Without `variants` the list is `[{ "id": "standard" }]`.
`GET /api/v1/sites/{siteId}/extensions/{installationId}/variants?component_id=…`
(MCP `list_extension_variants`) returns `{ variants, source }`; the page
editor's variant field is a select fed by the same call and becomes a text
field when the app does not answer. In HTML mode write
`<x-extension block="…" variant="lunch-talks" reserve="160" />`.

### Mount markup

```html
<div class="tr-extension-mount"
  data-tr-extension="com.typeroll.recurring-events"
  data-tr-extension-installation="inst_…"
  data-tr-extension-component="next-occurrence"
  data-tr-extension-variant="lunch-talks"
  style="min-height:160px">…default markup…</div>
```

There is no `data-block-data`. `style` is written only when `reserve_px` is set.

### Default markup

Once per publication, after build derivations, Core collects every contract
mount of the site (component, variant and page language; mounts in partials and
templates are asked for every site language) and calls each app once per
declared path:

```http
POST {api.base_url}{default_markup.path}
Authorization: Bearer <assertion, token_use "default_markup", body_sha256>

{ "mounts": [{ "key": "next-occurrence|lunch-talks|sv", "component_id": "next-occurrence", "variant": "lunch-talks", "language": "sv" }] }
→ {
  "markup": { "next-occurrence|lunch-talks|sv": "<a href=\"#anmalan\">Anmäl dig</a><script type=\"module\" src=\"{{asset:lottie.js}}\"></script>" },
  "assets": [{ "name": "lottie.js", "content_type": "text/javascript", "body_base64": "…" },
             { "name": "events.css", "content_type": "text/css", "body_base64": "…" }],
  "styles": ["events.css"]
}
```

- `markup` is written inside each mount of the built pages, unfiltered (only
  trusted developers can declare a contract). Keys are opaque; answer with the
  keys you were sent. A page whose language was not asked for uses the site's
  default language. Up to 256 KiB per mount.
- `assets` (optional) are files written into the publication at
  `/_assets/apps/{extension_id}/{sha256 prefix}/{name}` (immutable caching like
  other publication assets); `{{asset:name}}` in the markup is replaced by that
  path. `name` is a simple file name; `content_type` is one of
  `text/javascript`, `application/javascript`, `text/css`, `application/json`,
  `image/svg+xml`, `image/png`, `image/webp`, `font/woff2`; at most 2 MiB per
  file and 10 MiB per app per build. A name returned twice with the same content
  is kept once; with different content the answer is invalid.
- `styles` (optional) names returned `text/css` assets. Core links them in the
  `<head>` of every page with a mount of that app, once per page, before the
  page's first stylesheet so platform and site CSS can override them. CSS for
  features that load later is the app's own business at runtime.

The answer is frozen with the publication (`extension_markup`), so default
markup changes reach a site at its next ordinary build and never trigger one.
When the app does not answer, answers with an error or answers something
invalid, the previous publication's markup for those mounts is reused together
with its assets and styles, else the mounts stay empty. The publication never
fails on it: each fallback is a non-blocking `extension_default_markup_unavailable`
warning in `job.warnings`. Previews and the editor canvas do not call the app:
their mounts are empty until the component loads.

### Runtime

```js
export async function mount(element, { variant }, context) {}
```

The browser host imports `entry.module_url` directly (nothing is vendored into
the publication, and the snapshot carries no per-release paths) and calls
`mount` with `context.variant` equal to the variant; everything else in
`context` is as described in the frontend contract. `element` holds the default
markup until the component replaces it, and keeps it when the module cannot
load. A static component (no `module_url`) is never mounted. The module is a
cross-origin module script on published sites and an opaque-origin import in
previews and the editor canvas, so serve it, and every file it imports, with
`Access-Control-Allow-Origin: *`. Previews load the module the same way as
published sites; the editor canvas imports it inside its nested opaque-origin
frame instead of running verified bundle bytes.

## Admin SSO

Typeroll posts a 60-second launch code, issuer, installation id and page id to
the exact declared launch URL. The provider exchanges the code server-to-server:

```http
POST /api/extensions/token
Content-Type: application/json

{"grant_type":"authorization_code","code":"…","client_id":"…","client_secret":"…"}
```

The access token is a five-minute ES256 JWT. Validate `iss`, `aud`, `sub`,
`developer_org_id`, `org_id`, `site_id`, `installation_id`, `permission`,
`scopes`, `jti`, `iat` and `exp` against the issuer's discovery/JWKS.
`developer_org_id` must equal your own developer Organization: Extension ids
are reserved per developer from Core 0.2.113, but `aud` alone does not prove
the token was minted for your Extension. Never expose the Extension
client secret in the browser.

Self-hosted portals publish discovery and JWKS on their own canonical
`PORTAL_PUBLIC_URL`. If `auth.pairing_url` is declared, a site admin can start
an explicit pairing. Typeroll sends a signed, five-minute pairing assertion,
nonce and JWKS fingerprint; the provider must fetch discovery/JWKS itself and
echo the exact issuer, nonce and fingerprint only after verification.

If `auth.provisioning_url` is declared, installing (and `connect_extension`)
mints a server credential and POSTs it to that URL with a 60-second
`credential_provisioning` assertion bound to the credential's SHA-256. The
provider answers `{ bound: true }` after verifying it; otherwise the new
credential is revoked and the previous one is left as it was.

## Service credentials and direct provider API

Installation credentials use the existing `/api/v1/sites/{siteId}/…` API.
Send the credential as Bearer plus:

```http
X-Typeroll-Organization-Id: <owner org>
X-Typeroll-Installation-Id: <installation id>
```

The API maps route/method to one required Extension scope and rejects unknown
routes. Rotation returns a secret once and can leave a short grace window for
the previous credential.

Frontend code calls manifest-declared provider paths through
`context.api.fetch()`. The browser calls `api.base_url` directly with
`credentials: omit`; Typeroll never forwards the payload. When the manifest
requests `signed_installation`, the provider receives a five-minute,
origin-bound `X-Typeroll-Extension-Token`. It proves the enabled installation,
not the visitor's identity or authority over provider-owned data.

Provider API routes are unavailable in preview unless the route declares an
exact `preview_methods` subset. Preview form bindings remain discoverable so
the component can render faithfully, but submission tokens are removed and
`context.forms.submit()` fails without writing data. For example:

```json
{
  "path": "/catalog/*",
  "methods": ["GET", "POST"],
  "preview_methods": ["GET"]
}
```

Preview installation proofs carry `preview: true` and the exact
`preview_routes` allowlist. Providers must enforce that allowlist as well as
their normal route authorization; browser-side checks are not a security
boundary. A provider that needs write-path fidelity should point a separate
staging Extension at a test tenant and opt in only the test-safe methods.

The isolated preview has an opaque browser origin. Its `Origin` header and the
signed preview token's `origin` claim are therefore both the literal string
`null`. Equality between those values does not prove a published site origin.
Providers must additionally require `preview: true` and enforce the signed
`preview_routes` method/path allowlist server-side.

Typeroll previews are returned with `noindex, nofollow`, `no-store`, and an
opaque-origin sandbox. `noindex` is crawler guidance, not access control; the
sandbox and short-lived signed preview link are the security boundaries.

Bundled Extension code in preview is requested from the portal preview page,
not from the published site's domain. Browser-side third-party credentials
restricted by HTTP referrer or page origin must therefore allow the portal's
preview origin, or the provider will reject those preview requests. Prefer a
separate, narrowly restricted preview credential instead of weakening the
published credential's domain restrictions.

## Lifecycle events

Events use `Idempotency-Key` and the headers:

```text
X-Typeroll-Event
X-Typeroll-Event-Id
X-Typeroll-Timestamp
X-Typeroll-Signature: v1=<hex hmac>
```

Verify HMAC-SHA256 over `<timestamp>.<raw-body>`, reject stale timestamps and
deduplicate the event id. Delivery retries network failures, 408, 429 and 5xx.

## Self-hosting configuration

Required for production Extension identity:

```text
PORTAL_PUBLIC_URL=https://admin.example.com
EXTENSION_SIGNING_PRIVATE_JWK=<P-256 private JWK JSON>
```

During signing-key rotation, set `EXTENSION_SIGNING_PREVIOUS_PUBLIC_JWKS` to a
JWKS document containing the previous public key(s). The discovery endpoint
publishes both new and overlapping old keys while all new tokens use the new
private key. Remove old keys after the longest token/pairing validity window.

`TYPEROLL_TRUSTED_APP_DEVELOPER_ORGS` (comma-separated organization ids)
names the developer organizations that may publish and run
[app contracts](#app-contracts); leave it unset to allow none.

`PLATFORM_ADMIN_EMAILS` enables the hosted-only public review surface. With no
platform admin and no locally imported catalog entries, self-hosting remains a
private/unlisted system and makes no catalog network call.

## Operational behavior

- Disable immediately blocks new Extension tokens and launch but keeps configuration.
- Deprecation warns admins; an installation follows a compatible replacement
  automatically when one is published.
- Revocation removes that release from automatic selection and withdraws the
  matching catalog entry. If another compatible release exists, the timeless
  installation continues on it.
- No release can add scopes to an installation. New access always requires an
  explicit site-admin grant.
- Uninstall revokes credentials and removes derived definitions/nav, but page
  block instances remain as explicit unavailable placeholders.
- Diagnostics list health, credential metadata, audit actions, event delivery
  classes and declared URL inputs without exposing secrets or token values.

## Protected documentation and scoped server capabilities (Core 0.2.9)

Runtime 0.40.0 adds `documentation.access: "installation"`. The document URL
must be on an approved provider origin. Core sends a 60-second ES256 assertion
with `token_use: "documentation"`, empty scopes, the app audience, issuer,
organization, site, installation and resolved version. The provider verifies
these claims against its paired issuer and current enabled installation before
returning Markdown. Core bounds reads to 256 KiB, rejects redirects, checks
public destinations, and reports failure as `unavailable`. No private guide
text may appear in the manifest, runtime snapshot, public docs or bundled MCP.
The endpoint is `GET /api/v1/sites/{siteId}/apps/documentation`; it requires site
read access. Instructions are reference data, never an authorization grant.

Installation credentials can use these generic APIs with explicit scopes:

| API | Scope | Boundary |
| --- | --- | --- |
| `GET /extensions/self` | `extension:config:read` | Own enabled installation, validated non-secret config, `version`, `published_version` and verified site origins |
| `GET/PUT /pages/{pageId}/owner-fields` | `content:owner` | Next release: typed owner fields + revision; PUT creates a pending proposal, never directly saves a Page. See the owner-review guide. |
| `POST /delivery/email` | `email:send` | Single recipient, bounded plain text, configured site connector, no connector credentials returned |
| `POST /forms/{formId}/actions` | `forms:execute` | Before/after actions on a form bound to this installation only |

Paths in this table are relative to `/api/v1/sites/{siteId}`. The three new
write scopes require administrator approval. Ordinary CMS API keys do not
acquire visitor/owner authority. The provider must authenticate the visitor and
bind each session to its authorized record before using owner-field APIs.

Forms may declare `target: { installation_id, path, hydrate?, session_param? }`.
Only a declared POST route on an enabled installation is accepted. Form
creation and target updates require admin authority; a provider may bind only
its own installation. Existing form steps, styling, actions and field names
remain Core data. Endpoint resolution fails closed for a missing/disabled app;
it never converts an app operation into a normal Forms submission.

`version` in `GET /extensions/self` is the release the app API runs now.
`published_version` is the release the live publication was built with: the
version recorded for this installation on the site's last publication
(`null` when nothing is published, the installation is not in it, or the
publication predates recorded versions). Changing an installation's version
takes effect for the app API immediately, but live pages keep calling the
published version until the next publication activates. A versioned app
Worker must therefore keep answering requests for `published_version` and
switch only when it changes; treat `null` as unknown and fall back to
`version`. After a version change, run a dry-run publication and publish soon.
A domain-only republication keeps the published versions.

A publication whose form target is not declared for POST by the
installation's active version fails with `form_app_endpoint_unavailable`
(`form_app_installation_unavailable` for a missing or disabled installation),
naming the form, installation, path and active version. An explicit version
change (`PATCH /extensions/{installationId}` with `version`) is refused with
409 `form_targets_undeclared`, `requires_confirmation: true` and
`affected_forms` (`form_id`, `name`, `path`) when the release it resolves to
does not declare a form's endpoint. Install a release that declares it, change
the form target, or repeat with `confirm_form_targets: true`.

Bundled components receive optional `context.analytics` with endpoint, public
site token and `requires_consent`. Core accepts only configured Analytics event
rules; the component remains responsible for respecting visitor consent. Core
does not implement the provider's campaign storage or outbound-link behavior.

### Prepared private Form intake

The next-release `POST /forms/{formId}/intake` contract uses `forms:execute`, requires
an exact target installation, pins the form and trusted context, and stores private
submissions with idempotent completion. It does not execute form actions. See the
public Extension backend guide for the request and constraints. Native Form targets
may opt into `session_exchange: "confirm_post"` to redeem links only after an
explicit click and POST; API and MCP accept the same target field.
