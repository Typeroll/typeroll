# Multiple organizations

A user can create or join more than one organization in the same Typeroll
instance. Use **Organization** above the site selector to switch. Use
**Create or join organization** to create another organization or redeem an
invitation. Existing members can follow invitation links without signing out.
Creating an organization grants its creator the owner role. An invitation adds
an editor and preserves any existing role when redeemed again. New organizations
enforce member roles from creation; existing organizations keep their settings.

Each organization has its own sites, roles, sharing grants, publishing accounts,
and credentials. Switching returns to the dashboard and clears the site version
selection. A role in one organization grants no role in another. Staging and
production remain separate instances with separate memberships, even when a
person uses the same email address.

## Session and discovery contract

The verified Firebase identity remains unchanged when switching organizations.
The HTTP-only, SameSite=Lax `typeroll_organization` cookie stores a browser-local
selection bound to that identity. It is advisory: every session read validates
the selected organization's existence and current member document. A missing or
invalid membership becomes an organization-less session and cannot fall back to
a legacy claim. Separate browser profiles can select different organizations;
tabs in the same profile share the selection. Reload other tabs after switching.
Logout clears both organization and site-version selection.

`user_organizations/{uid}/organizations/{orgId}` is a discovery index, not an
access grant. Creating, joining, listing and switching register verified
memberships. Every listed entry is revalidated against the organization and
member documents, so stale or forged index entries grant nothing. Existing
single-organization accounts discover their claim-based organization lazily;
after discovery, its membership must remain valid even when the selection cookie
is absent. Accounts without an organization claim discover their indexed
memberships after a new login. No Firebase custom claims are overwritten by
creation, joining or switching. Parent index documents are persisted so normal
self-host backups include their membership subcollections. No bulk data migration
is required.

Older runtimes ignore this index and selection cookie. A rollback preserves the
data, but users who have no legacy organization claim need this runtime restored
before they can use their new memberships again.

If an administrator provisions membership documents outside normal onboarding,
also create the matching discovery index entry. Removing a membership revokes
selected access immediately; an index entry alone never preserves it.

API endpoints (authenticated cookie session, same-origin CSRF protection for
mutations):

- `GET /api/orgs`: current memberships and active organization; `no-store`.
- `POST /api/orgs/switch` with `{ "orgId": "example" }`: verify membership and
  select the organization, or return 404.
- `POST /api/orgs/create` and `POST /api/orgs/invite/join`: preserve previous
  memberships and select the new one without changing the Firebase identity.

## Verification

The existing local owner, outsider and pending personas are documented in
`config/e2e-personas.json`. Seed and verify an isolated local fixture tree with
`npm run e2e:personas -- seed --environment local --fixtures-dir temp/org-personas`
and `npm run e2e:personas -- verify --environment local --fixtures-dir temp/org-personas`. `organization-switching.spec.ts` creates disposable
organization data in the E2E fixture tree and exercises desktop/mobile switching,
invitation acceptance, role boundaries, foreign-org denial and revocation.
The session and route unit tests also cover cookie tampering, another user's
selection, missing membership, logout, login recovery, and concurrent slug
reservation. Provider OAuth callbacks remain bound to their initiating
organization: switch back before completing an authorization started elsewhere.

Candidate verification on September 7, 2026: the complete release check passed
(2,160 tests, type checks, dependency audit with the existing temporary advisory
exception, and all workspace builds). The local browser suite passed 21 tests;
three remote-only cases remain for hosted qualification. Desktop and 390px mobile
screenshots were inspected. Temporarily bypassing membership validation caused
five authorization assertions to fail; restoring it passed the release check.
The local persona seed was run twice and verification passed. No customer account
or deployed environment was changed by these local checks.

The Core 0.1.17 follow-up keeps sign-out in the fixed sidebar footer on short
mobile screens and disables organization inputs/actions until their client code
is ready. New browser regressions reproduce both defects against 0.1.16. The
corrected candidate passes the full release check and all 23 local browser tests
(three hosted-only cases remain for remote qualification); the 320px and desktop
screenshots were inspected. The minimum-viewport test verifies the real logout
response and removal of the local persona cookie, since local development
intentionally falls back to its dev user after logout.
