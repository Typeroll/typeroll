# Apps, Extensions and hosting boundaries

Status: normative

This document defines product ownership and runtime placement. If another plan
or document conflicts with it, this document wins.

## Product categories

### Typeroll core modules

Forms, Analytics, Directory and similar modules implemented in the open-source
repository are core CMS capabilities. In Typeroll Cloud their APIs run in the
Typeroll Cloud environment. In a self-hosted installation their APIs run in
the operator's environment.

Forms is included in the base product in both editions. Cloud plans may apply
usage, retention or delivery limits, while self-hosted operators provide their
own compute, storage and delivery services. Forms must not require a Typeroll
App or Extension purchase.

Some existing source types, datastore paths and HTTP routes use `App`, `apps`
or `/settings/apps` as legacy internal identifiers. They remain for backward
compatibility and must be described as **core modules** in product UI and new
documentation. They are not Typeroll Apps.

### Typeroll Apps

“Typeroll Apps” is the name of a separately sold premium product collection.
Typeroll owns, operates and deploys every Typeroll App exclusively in
Typeroll-controlled cloud accounts. This remains true when the customer uses a
self-hosted Typeroll CMS.

The open-source repository contains the Extension protocol needed to install
and use a Typeroll App. It does not contain the premium application's backend,
business logic, secrets or deployment. No Typeroll App Worker or Function is
deployed to a customer's Cloudflare, AWS, GCP, Vercel or other account.

### Third-party SaaS and bespoke applications

A third-party developer owns and operates the application's backend and data
in the developer's accounts. This applies both to multi-tenant SaaS products
and customer-specific systems such as planners, quote tools and portals.

Typeroll does not proxy traffic to these backends. The published component or
provider iframe calls the provider API directly. The provider is responsible
for CORS, availability, tenant isolation, business authorization, data
handling and customer/recipient tokens.

### Custom lead interfaces backed by Forms

A bespoke calculator, quiz, lead magnet or quote frontend may use the normal
Typeroll Forms module instead of having its own backend. It calls the Forms API
directly with a form-bound signed submission token. For Typeroll Cloud the
target is the hosted Forms service; for self-hosting it is the self-hosted
Forms endpoint. This is a core capability, not a third-party app proxy.

## Extension transport

An Extension is an installation and identity protocol, not a reverse proxy.

- The manifest declares immutable frontend assets, provider API base URL,
  client-visible routes, admin launch pages, configuration and permissions.
- A trusted bundle is hash-pinned and copied into the static site build. An
  untrusted or independently updated UI uses a sandboxed provider iframe.
- `context.api.fetch()` sends requests from the browser directly to the
  manifest's provider-owned `api.base_url` with `credentials: omit`.
- With `api.authentication: signed_installation`, the CMS issuer returns a
  five-minute, origin-bound ES256 installation token. The runtime places it in
  `X-Typeroll-Extension-Token` on the direct provider request.
- That token proves which enabled installation and issuer initiated a public
  request. It is not a user login and does not authorize access to provider
  customer data. Recipient tokens and provider sessions remain the provider's
  responsibility.
- Admin pages use a single-use launch code and server-to-server token exchange
  with the provider. Service access into Typeroll uses separate installation
  credentials.
- A self-hosted issuer must be explicitly paired and trusted by the provider.
  Self-hosting never makes an issuer automatically trusted.

The following are prohibited architecture:

- a generic Typeroll-operated reverse proxy for third-party provider APIs;
- a provider API proxy generated into a customer's static hosting project;
- provider secrets, durable installation credentials or admin tokens in a
  public site snapshot;
- deploying Typeroll Apps backend code into a customer or self-host operator's
  cloud account.

## Static site deployment

Typeroll publishes static HTML, CSS, JavaScript, media references, redirects
and static metadata. It does not generate per-site Cloudflare Pages Functions
for Extensions, Forms or Directory. Dynamic calls go to their owning API
directly.

Staging index protection is unrelated to Apps and Extensions. Hosted
`*.sites.typeroll.com` traffic must receive `X-Robots-Tag: noindex, nofollow`
from a single zone-level edge rule owned by the Typeroll hosting platform.
Self-host operators who offer a fallback domain configure the equivalent rule
on their own fallback zone. Customer production domains keep their normal
static `robots.txt`.

## Ownership matrix

| Surface | Runtime owner in Typeroll Cloud | Runtime owner with self-hosted CMS |
| --- | --- | --- |
| CMS core and Forms | Typeroll Cloud | Self-host operator |
| Typeroll Apps premium backend | Typeroll | Typeroll |
| Third-party SaaS backend | Third-party developer | Third-party developer |
| Bespoke backend | Implementing developer/agency | Implementing developer/agency |
| Static customer site | Customer's configured host | Self-host operator's configured host |
| Hosted fallback noindex rule | Typeroll hosting zone | Not applicable unless the operator offers a fallback zone |
