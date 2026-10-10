# Beta authentication and MCP consent review

Candidate: Core 0.2.76 / MCP 0.45.58. Prepared 2026-10-10; not a production
rollout record. Portal behavior lives in Core; Cloud must pin and qualify the
matching release. The stdio package update only updates its embedded guide.

## Existing behavior and corrections

- Signup previously collected email/password only. Organization naming already
  happened on `/onboarding`. Keep that separation so invitees do not accidentally
  create a new Organization. Collect the person's name at signup; persist it in
  Firebase before exchanging the refreshed ID token. Company/project/workspace
  name is the Organization name on the next screen.
- Remove the Google popup button. Keep existing Firebase identities and provide
  password reset using the same address. Do not disable the provider remotely or
  delete/link accounts as part of a source change.
- Preserve same-origin application, invitation and MCP-consent continuations
  through sign-in and onboarding. Reject open redirects, backslashes and paths
  that normalize outside the explicit allowlist.
- Session bootstrap previously bypassed CSRF and exposed provider error text.
  Require the exact configured portal Origin; authenticate with revocation
  checking and a sign-in no older than five minutes before minting a cookie.
  Keep HttpOnly/Secure/Lax cookies. Firebase browser persistence is memory-only
  and cleared after exchange; backend session revocation checks remain in place.
- Add datastore-backed CAS limits: sessions 30/minute, OAuth registration
  60/minute, token exchange 120/minute per trusted address; consent 10/10 minutes
  per user, Organization creation 5/hour and invitation acceptance 20/10 minutes
  per user. Contention/store outages fail closed. `Retry-After` is returned.
  These protect portal endpoints, not direct Firebase password requests.
- Create the Organization and owner membership atomically. Existing setup of
  Default Hosting Group and membership discovery remains unchanged.
- MCP previously offered OAuth discovery but required pasting an API key in the
  consent form. The new flow uses the signed-in owner/admin, explicitly selects
  an Organization and one owned active Site or organization-wide access, and
  creates a distinct revocable delegated credential. Organization scope also
  includes shared-in Sites at their existing share permissions. Editors cannot
  approve admin-equivalent access.
- Validate callback schemes, exact registered callback, S256 PKCE, client ID,
  optional resource and scope on both entry and submission. Never auto-approve.
  New access/refresh credentials are authenticated encrypted envelopes so the
  underlying delegated API key cannot be extracted from the token. Codes are
  opaque, encrypted at rest and atomically consumed once. Refresh credentials
  rotate once across instances; replay revokes the connection. Removing or
  demoting the approving member, disabling/revoking their Firebase identity,
  explicit key revocation or the 30-day grant lifetime ends access.
- Existing manually supplied API keys remain supported. Pre-release JWT-based
  OAuth connections retain their original behavior until expiration/revocation;
  reconnect to obtain the membership-bound, rotating new grant. No secrets are
  returned through the consent page or URL.

## Deployment checks still required

1. Qualify the exact Core pin on Cloud staging, including a real password login,
   signup/invitation continuation, reset delivery to an authorized test inbox,
   and actual client OAuth (for example Claude). Local protocol/browser tests
   are not a claim of vendor-client certification or email deliverability.
2. Read-only API inspection on 2026-10-10 confirmed email/password and
   improved email privacy are enabled in both `typeroll-staging` and
   `typeroll-production`. Neither returned a configured password policy.
   Configure provider-side password
   policy (12+ characters) and email-enumeration protection. Client validation
   alone cannot enforce provider policy or prevent direct SDK/REST attempts.
   Firebase's abuse throttling is distinct from these portal budgets. See
   [Firebase limits](https://firebase.google.com/docs/auth/limits) and
   [session cookies](https://firebase.google.com/docs/auth/admin/manage-cookies).
3. Verify the deployed ingress topology before configuring
   `AUTH_TRUST_PROXY_HOPS`. Zero (default) ignores forwarded headers and uses the
   adapter socket address; behind a proxy this can share a budget. Set the number
   of append-only trusted X-Forwarded-For hops, never trust the caller-supplied
   leftmost address. Verify spoofed prefixes cannot change the budget and avoid
   alternative ingress paths with a different hop count. For a Google external
   load balancer its documented appended pair is client IP, load balancer IP;
   additional proxies change that count. Do not guess a production value.
4. Set `PORTAL_PUBLIC_URL` to the exact HTTPS portal origin and retain a strong
   `MCP_OAUTH_SIGNING_KEY`. OAuth browser forms use `Referrer-Policy: same-origin`
   to preserve same-origin POST Origin while not disclosing query parameters to
   third parties. Callback redirects use no-referrer; consent cannot be framed.
5. Include auth support collections in operational retention: expired
   `auth_rate_limits`, `mcp_refresh_uses` and `mcp_authorization_codes` documents
   can be deleted after `reset_at`/`expires_at`. They contain numeric epoch
   milliseconds, **not Firestore TTL timestamp fields**: do not enable a TTL
   policy on those numeric fields and claim cleanup is configured. Authorization
   expiration is checked independently of physical deletion. Budgets reuse one
   document per hashed identity/address; refresh tombstones persist until cleaned.

## Remaining boundaries

This is a targeted authentication/onboarding review, not a penetration test of
all CMS routes. Thomas explicitly confirmed open registration on 2026-10-10. Signup remains
open to anyone with access to the portal; the marketing beta-request form is
not an admission gate. Email ownership verification is not yet a prerequisite
for creating a workspace. Existing signed organization
invite links remain reusable bearer invitations until expiry and cannot be
individually revoked. Keep that intentional sharing model visible to operators.

Do not promise that a dropped response after successful organization creation is
fully idempotent: database ownership is atomic, but client retries of creation
can still create a second suffixed organization. A durable request key would be
needed for exactly-once recovery across the whole onboarding setup.

## Verification

Focused tests cover origin rejection, fresh/revoked sessions, generic errors,
name persistence, password reset UI, single-use authorization codes, PKCE/client/
resource binding, cross-tenant denial, scoped consent, refresh rotation/replay,
membership removal, encrypted credentials and concurrent shared budgets.
Browser scenarios exercise consent at 375/768/1280px plus real HTTP authorization,
token exchange and MCP initialization using synthetic local personas. Existing
organization-switching journeys cover creation, joining, role preservation,
revocation, hydration and mobile layout. No customer sites or mail are used.

The checkout also contains a separate uncommitted app-derivation task. Those
files are excluded from this auth candidate; a whole-checkout run is supplementary
integration evidence, not proof of the isolated committed artifact. Record CI
for the exact PR before any release.

Local candidate evidence (2026-10-10): source release preflight, dependency audit,
public docs checks/formatting and all workspace typechecks passed. The full
checkout unit gate reached 2,749 passing portal tests with one failure in the
separate uncommitted `extension-admin-transport` work (error wording assertion).
Publication upgrade checks, frozen template build and all workspace builds
passed separately after that stop. The focused auth/security suite also covers
bounded chunked request bodies. Consent screenshots were inspected at
375/768/1280px; no clipping or horizontal overflow. All nine targeted browser
scenarios passed, including revocation returning HTTP 401 for the previously
working MCP access token. Local HTTP browser
callbacks are checked at the portal's actual 302 response, since the synthetic
client host has no running OAuth application. Real client acceptance is still
a staging requirement.
