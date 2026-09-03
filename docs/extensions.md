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
`install --site` and `promote`. The CLI calls the same APIs as the portal; the
server remains authoritative for full validation.

Site automation can read and update an installed Extension through
`GET/PATCH /api/v1/sites/{siteId}/extensions/{installationId}`. The matching
MCP flow is `list_extension_installations` → `read_extension_installation` →
`update_extension_installation_config`. A successful update returns
`redeploy_required: true`; publishing remains a separate, explicit deploy.

CLI convenience backlog: add `typeroll extension configure --site <site-id>
--installation <installation-id> --config <file>`. This should wrap the v1
PATCH above and surface its redeploy flag; it must not deploy implicitly.

## Frontend contract

A bundled component exports:

```js
export async function mount(element, props, context) {}
```

`context` contains protocol/runtime versions, installation/component ids,
public config, the declared URL-context accessor, an in-memory navigation
object, site navigation, installation-scoped JSON storage, `api.fetch()`, and
`preview` (`true` only in an isolated preview).
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

## Admin SSO

Typeroll posts a 60-second launch code, issuer, installation id and page id to
the exact declared launch URL. The provider exchanges the code server-to-server:

```http
POST /api/extensions/token
Content-Type: application/json

{"grant_type":"authorization_code","code":"…","client_id":"…","client_secret":"…"}
```

The access token is a five-minute ES256 JWT. Validate `iss`, `aud`, `sub`,
`org_id`, `site_id`, `installation_id`, `permission`, `scopes`, `jti`, `iat`
and `exp` against the issuer's discovery/JWKS. Never expose the Extension
client secret in the browser.

Self-hosted portals publish discovery and JWKS on their own canonical
`PORTAL_PUBLIC_URL`. If `auth.pairing_url` is declared, a site admin can start
an explicit pairing. Typeroll sends a signed, five-minute pairing assertion,
nonce and JWKS fingerprint; the provider must fetch discovery/JWKS itself and
echo the exact issuer, nonce and fingerprint only after verification.

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
