# Extension threat model

## Protected assets

- portal sessions and organization boundaries;
- site content, submissions, media and deployment authority;
- installation credentials and secret configuration;
- recipient URL tokens and provider customer data;
- static site availability and build integrity.

## Trust boundaries

The portal control plane, generated static site, token issuer, provider
frontend code, provider admin frame and provider backend are separate trust
zones. An Extension developer is not implicitly trusted with a portal session
or undeclared Typeroll data. A self-hosted issuer is not implicitly trusted by
an external provider.

## Controls

- Manifest URLs require public HTTPS destinations. The browser runtime allows
  only declared relative API routes, omits credentials and rejects redirects.
  This is defense in depth; the provider remains the security authority.
- Bundles are size-limited, SHA-256 verified at release and again when
  vendored. Published manifests and assets are immutable by version.
- Public build snapshots contain public configuration only. Secret properties
  cannot be public or have defaults and are encrypted at rest.
- Scopes are granted explicitly and intersected with the current human
  permission. Installation credentials are site-bound, hash-stored, rate
  limited and independently rotatable.
- Launch codes are random, expire after 60 seconds and are consumed with an
  atomic compare-and-update. Delegated JWTs bind issuer, audience, user,
  organization, site, installation, scopes, `jti`, issue time and expiry.
- Public Extension tokens are short-lived ES256 JWTs bound to issuer,
  audience, organization, site, installation and requesting site origin. They
  prove installation identity but are not user authorization.
- Customer URL context is declaration-only, length/pattern checked and held in
  per-mount closures. `consume` removes it from browser history after all
  components capture their values. It is not an authentication guarantee;
  providers must make tokens random, expiring, revocable and action-scoped.
- Editor customer content runs with an opaque origin. Third-party live-preview
  code runs in a nested opaque frame and cannot be the source Window accepted
  by the editor bridge.
- Admin frames use an exact launch origin, no referrer, CSP and sandbox.
- Lifecycle events contain operational identifiers only and use timestamped
  HMAC signatures plus stable idempotency keys.

## Provider responsibilities

Providers configure CORS for installed customer origins, validate every JWT
claim, maintain a strict trusted issuer set, isolate tenants/installations,
protect customer tokens from replay and enumeration, authorize each business
action, retain/delete personal data as declared, and operate their own
availability, mail and incident response. Typeroll never proxies the request.

## Residual risks

- A provider can mishandle data it is explicitly granted. Review, disclosure
  and contractual controls complement technical isolation.
- Revoking a version cannot erase already downloaded static assets. New
  installation tokens and admin access stop immediately; a new deploy removes
  the frontend. Providers must also honor lifecycle revocation promptly.
- The in-process rate limiter is per portal process. Horizontally scaled
  installations should replace it with a shared limiter.
- A recipient URL may leak through the recipient's browser, extensions or
  screenshots before Typeroll consumes it. Tokens must not be permanent bearer
  credentials for high-risk actions.
