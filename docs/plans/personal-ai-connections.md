# Personal AI connections

Status: implementation candidate, not released. Core owns the portal, OAuth,
public API, MCP and generic recipes. Cloud adopts this through its immutable
Core release pin. Private Apps retain their own authenticated documentation.

## Contract

One OAuth connection belongs to a person. It discovers all their currently
accessible sites across indexed organization memberships and canonical site
shares. Each request revalidates the grant, account, membership and site access.
The current portal role policy is reused, including the existing per-organization
`roles_enforced` migration flag; this change does not silently migrate old
organizations. New connections cannot administer an organization without a live
owner/admin membership, regardless of that legacy flag.

Manual site/organization API keys keep their existing scope. Old OAuth grants
remain revocable in API keys until they expire; reconnect for personal access.
Personal connections live under `personal_connections/{user}/connections`, with
hashed credentials in the existing lookup. No plaintext credential is persisted.
PKCE, encrypted single-use codes, audience/client binding, refresh rotation and
30-day absolute connection expiry remain. Revocation also invalidates refresh.

Before site tools run, `select_site` binds organization, site and version into a
credential-signed, 24-hour `site_context`. Every site tool requires that context.
There is no global active-site setting: simultaneous chats retain independent
contexts. Missing/deleted versions fail rather than falling back to main.
Selection is a safety boundary, not a replacement for live authorization.
A model cannot prove human confirmation; instructions request confirmation and
the server enforces the selected target thereafter.

Organization tools require an explicit organization ID. Discovery returns site
metadata only; searches never span sites. `resolve_page_url` compares stored
routes on the selected site, including content-type routes, without fetching
arbitrary URLs. Generated facet routes and redirects may have no editable Page.

Editors may author custom block types, shared Page templates and reusable
sections. Read-only access remains read-only. Administrative settings, access,
provider connections and lifecycle retain their existing checks. Block scripts
use the same rendering sandbox and authoring controls as other trusted content.
Shared definition changes can affect many pages; recipes require impact review.

## Instruction delivery

The hosted personal endpoint defaults to five compact discovery/dispatch tools.
Relevant recipes are fetched with `list_skills` / `read_skill`; site instructions
and enabled App guides are read live after selection. Do not bundle private
Apps guides or site data. Site settings contain versioned `agent_instructions`
with a 12,000-character limit and administrative write permission.

Plugin bundles are generated from the same generic MCP skill sources, for
ChatGPT/Codex and Claude. Their manifests contain one HTTPS endpoint and no
credentials. Self-hosted installations generate the same bundle with their own
portal URL. Catalog submissions and vendor approval are separate release steps.

## Acceptance and rollout

Verify owner/editor/read-only/removed-member access; equal site IDs across
organizations; current shared access; parallel contexts; expired/tampered
contexts; wrong version; OAuth consent without key copying; revocation and
refresh replay; explicit URL lookup; editor block authorship; desktop/mobile
consent and connection management. Run the full Core release gate and browser
suite on the exact PR candidate. No customer content migration is needed.

After review, obtain exact release approval, publish Core/MCP/docs, qualify the
matching Cloud pin on staging, then request/obtain the required production
approval. Test real external client OAuth after staging; local protocol tests
are not proof of catalog installation or vendor acceptance. Submit catalog
materials only with the owner's approval and required verified vendor account.

## Verification evidence (2026-10-16)

Implemented on `codex/personal-mcp-connections`, based on `7edbc7a`.
No release, catalog submission or Cloud deployment has been performed.

- Focused personal authorization tests: 11 passed, including disabled/deleted
  accounts, account-token revocation and identity-provider failure.
- Portal regression run: 2,766 passed, excluding the two-test
  `extension-admin-transport` file affected by unrelated pre-existing local work.
  The full gate exposed its changed error text (`262144 bytes` versus `256 KiB`).
  That work is preserved and excluded from this candidate; clean PR CI must
  validate the complete suite with no exclusion.
- MCP: 223 passed; shared: 1,180 passed; infrastructure: 228 passed.
- Seven browser tests passed: consent at 375/768/1280, editor OAuth, selected-site
  access and connection revocation, custom-block editor/admin flows. Screenshots
  at all three consent widths and mobile connection management were inspected.
- Dependency audit, docs checks, typechecks, publication upgrade verification,
  frozen static template, full workspace build and docs artifact preparation
  passed. After updating old permission assertions, affected portal tests passed.
- Plugin package tests verify both generated ZIPs, matching recipe/version,
  endpoint configuration and rejection of insecure/credential-bearing endpoints.

Local checks ran in the ordinary shared checkout with six unrelated dirty files
preserved byte-for-byte. PR CI is the authoritative clean-candidate full gate.
Actual ChatGPT/Claude client authorization and catalog review remain pending the
approved endpoint rollout. Browser protocol tests do not substitute for those.
