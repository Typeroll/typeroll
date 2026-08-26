# ADR 001: Typeroll Extension Platform

Status: superseded by manifest v3 transport; accepted otherwise

The normative product and hosting boundaries are defined in
[`../architecture/apps-extensions-and-hosting.md`](../architecture/apps-extensions-and-hosting.md).

## Context

Typeroll needs to host shared Typeroll Apps, externally operated SaaS
extensions and customer-specific applications without copying provider code
into the portal or coupling customer sites to a single cloud vendor.

## Decision

An Extension is installed per site as a timeless trust relationship. Each
published manifest release is immutable, and Typeroll automatically resolves
the installation to the newest runtime- and configuration-compatible release.
The
manifest can provision editor blocks and external admin pages, request
explicit REST scopes, declare public/private/secret configuration, and expose
a direct provider API contract. Frontend components are either hash-pinned
bundles vendored into a static build or sandboxed external frames.

The public page contains inert mount metadata and public configuration only.
The runtime reads declared URL context in the browser before mounting any
component. Sensitive values never enter generated HTML. Internal component
views use a memory router and do not require a Typeroll page path.

Admin access uses a 60-second, atomic single-use launch code exchanged by the
provider for a five-minute ES256 user token. Machine access uses separately
rotatable, site-bound installation credentials and the existing `/api/v1`
surface with centrally mapped scopes.

Static sites call provider APIs directly. When requested by the manifest, the
CMS issuer supplies a short-lived, origin-bound installation token which the
runtime attaches to the direct request. Typeroll does not forward the request
and no proxy is generated into the customer's hosting project. The provider
owns CORS, rate limiting and business authorization.

Editor canvases are opaque-origin documents. Selection, inline editing,
geometry, drag/drop and scroll sync use a versioned postMessage bridge.
Third-party bundled code is moved into a second opaque-origin iframe in the
editor so it cannot impersonate that bridge.

The Extension registry and issuer are part of the self-hosted build. Typeroll
Apps are a separate premium collection run only in Typeroll-controlled
accounts; their implementation is not part of the self-hosted build. The catalog
reads only the instance-local datastore unless an operator explicitly adds an
external registry provider. Public hosted releases require operator review;
private and unlisted releases do not.

## Consequences

- Providers own their product data, customer-link token lifecycle, mail and
  backend business logic.
- Typeroll owns rendering boundaries, permission intersection, issuer
  identity, secret separation, auditing and safe failure behavior.
- A published bundle is immutable and hash-pinned; a code change is a new
  Extension version.
- Installation scopes never expand with a release. New access requires an
  explicit site-admin grant, while compatible releases need no manual upgrade.
- An unavailable or incompatible Extension is omitted and diagnosed without
  failing the rest of the site build.
- Self-hosted issuers require explicit provider trust pairing. Running the OSS
  code does not make an issuer automatically trusted by a public SaaS.
- Existing page instances survive disable/uninstall and render an unavailable
  state instead of silently disappearing.

## Rejected alternatives

- Arbitrary scripts on the portal origin: breaks tenant and session isolation.
- Provider API keys embedded in static HTML: exposes durable credentials.
- One central Typeroll proxy/backend for every bespoke application: couples
  providers to Typeroll operations and data residency.
- One generated Typeroll page per recipient: creates unbounded content and
  deploy churn for what is provider-owned session state.
