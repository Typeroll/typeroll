# Guided domain migration and simpler Site settings

Status: implementation in progress; not released. No customer DNS, publications,
Cloudflare zones, redirect lists or traffic have been changed by this work.

## Outcome and boundaries

One site-scoped migration journey in Publishing, the public API and hosted MCP.
Saved intent, prepared output, explicit traffic approval, verification and rollback
must be different, visible states. A saved hostname must never imply live traffic.
Organization connections remain organization-owned; site hostnames remain site-owned.
Existing external DNS remains supported. Nameserver changes stay with the registrar.

## Required implementation

1. Preserve a verified content candidate when only redirect hosts change. Reconcile
   edge redirect requirements separately, revoke old traffic approval, and protect
   concurrent changes with revisions. No silent invalidation or content rebuild.
2. Before a change requiring new output is saved, return its impact and show a
   confirmation in the UI. Estimate from completed build timings when available;
   otherwise report unknown rather than invent a duration.
3. Reuse compatible render/media artifacts for an unchanged publication at new
   origins. Regenerate canonical, sitemap, references and validation receipts;
   never reuse private or incompatible output. Measure the three-minute target
   for the representative site; do not claim it from synthetic tests alone.
4. Classify transient media timeouts/network failures and retry the same frozen
   build with bounded attempts, durable checkpoints and visible retry progress.
   Permanent invalid inputs or authentication failures must not loop.
5. Validate redirect rules during dry-run and final artifact inspection with one
   consistent provider contract. Support 2,000 static + 100 dynamic rules and
   1,000 characters per rule; remove the contradictory 128 KiB transport cap.
   Account for generated rules as well as authored rules. Preserve bounds and
   artifact integrity. Never split `_redirects` into unsupported multiple files.
6. A guided domain API reports actionable checks: target hosting account, zone,
   authoritative nameservers, certificate coverage/readiness, permissions,
   publishing readiness, redirect capacity, candidate and current traffic.
7. Zone onboarding can create a zone in the authorized connected hosting account,
   stage a zone-file import or scan, compare discovered records against current
   DNS, and apply explicitly reviewed records as DNS only. Scans are incomplete
   inventories, especially for mail and DKIM; require completeness confirmation.
   Preserve existing records and never automatically change registrar nameservers.
8. Before traffic changes, persist a durable exact record/rule journal. Apply only
   reviewed changes, verify live output, and automatically restore journaled
   records on a confirmed failure or agreed validation deadline. Manual rollback
   uses the same journal and detects intervening DNS changes instead of silently
   overwriting them. Retries must be idempotent, never duplicate publications.
9. Expose the same guarded actions and schemas through UI, API and hosted MCP,
   including redirect_hosts, accept_validation_window and the guided journey.
10. Divide Site settings into focused, directly linkable sections: General,
    Design, SEO, Publishing/domains, Integrations/access and Advanced. Preserve
    unsaved edits, permissions, version context and existing settings on save.
    Provide mobile navigation, concise descriptions, explicit save confirmation,
    and collapsed uncommon controls. Keep organization Publishing distinct.

## Acceptance evidence

- Synthetic candidate survives adding/removing a redirect host and reaches a
  verified redirect without rendering content again; revision races rejected.
- Same published snapshot at changed origins reuses eligible HTML and media;
  output URLs and canonical/robots/sitemap behavior are verified in real builds.
- Transient media timeout retries without owner action; exhausted attempts and
  permanent failures surface clearly, without double execution.
- Dry-run and actual upload agree for 936 representative migration redirects;
  enforce provider count/line limits, including generated entries.
- Hosted MCP tools/list and tools/call prove schema and transport parity.
- External DNS onboarding preserves mail and existing web records as DNS only,
  presents a comparison and registrar instructions, then reaches ready_to_switch.
- Switch and rollback tests cover partial writes, interruption, stale approvals,
  external DNS edits and repeated actions. Live status requires positive evidence.
- Desktop/mobile Site settings checks cover navigation, saving just one section,
  browser back/deep links and no accidental resets of another section.
- Production benchmark, publication and removal of any redundant customer Bulk
  Redirect list require explicit scoped approval after staging qualification.

## Initial findings

- `saveSiteDomains` clears all candidates for every save, including no-op and
  redirect-only changes. Frozen jobs currently bind traffic approval and origins
  to the same domain revision; separating them must update the full coordinator.
- `direct-upload.mjs` caps both control files at 128 KiB and encoded controls at
  180,000 characters, below a valid large Pages redirect configuration.
- Media retry handling recognizes only selected codes; generic `build_failed`
  can hide a TimeoutError. Existing checkpoints and content-addressed media
  caches should be reused, not replaced with a second migration engine.
- Current MCP source and hosted schema regressions already include both reported
  missing fields. Actual deployed connector verification is still required.
- Render caches are scoped by organization/site/version. Global dependencies
  include site origins, so a host change currently invalidates page fingerprints.
  The reported `no_valid_cache` needs separate investigation from invalidation.
- Site settings is one long page containing publishing, domains, identity, design,
  SEO, consent, scripts, agent instructions, access and lifecycle operations.

Provider references checked 2026-10-25:
- https://developers.cloudflare.com/pages/configuration/redirects/
- https://developers.cloudflare.com/api/resources/dns/subresources/records/
- https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/scan_review/
- https://developers.cloudflare.com/api/resources/ssl/


## Delivery status — 2026-10-26

Implemented on `codex/guided-domain-migration`, prepared as Core 0.2.107 / MCP
0.45.81. The user authorized merging and deploying PRs #78–79 together.
This candidate includes `ae7f60a` / PR #78 and integrates Core 0.2.106.
Release and deployment remain pending the exact combined-source checks and
Cloud staging qualification. Preserve ordinary publication at active/temporary
origins; only an explicit late preparation uses future domains. Redirect-only
changes cannot revive a candidate invalidated by newer published content.

### Implemented contracts

- Seven directly linkable Site settings sections, mobile section selector,
  independent saves, dirty-state retention, conflict and failure feedback.
- One site domain guide through UI, authenticated API and hosted/standalone MCP.
  Checks include hosting, hosts/zones, nameservers, edge certificates, permissions,
  publishing/export prerequisites, migration launch evidence when an inventory
  exists, redirect capacity, candidate phase and verified live state. Existing
  addresses are collapsed by default. Refreshing status never executes a switch.
- An impact preview and explicit confirmation before replacing a prepared
  candidate. Estimates use completed preparations, with unknown stated honestly.
  Redirect-only changes retain output identity and revoke traffic approval.
- Organization-admin pending-zone creation, asynchronous DNS scan, public-DNS
  comparison and explicitly confirmed DNS-only copying. Plans bind the site,
  account, connection revision and inventory; leases and record checks make
  retries idempotent. Active zones, conflicting records and empty inventories
  are not overwritten. Registrar changes remain a human step.
- Transient media TimeoutError classification uses the existing bounded retry
  chain and durable media checkpoints. Authentication/integrity/input failures
  are not reclassified as transient.
- Common Pages serializer/limit checks in source preflight and final upload:
  2,000 static, 100 dynamic, 1,000 characters per line. The bounded `_redirects`
  envelope is 10 MiB; `_headers` remains 128 KiB. Generated slash/host aliases count.
- A complete-input proof permits origin-only reuse of compatible raw HTML.
  Route dependency receipts are refreshed, derived browser-data changes invalidate
  reuse, and final output still passes publication validation. Promotion retains
  the completed build task instead of dispatching a second build.
- Durable DNS/rule journals capture the baseline before traffic writes. Unique
  write intents recover lost responses; automatic timeout/failure and manual
  rollback use the publication lease. TTL, comments, tags and settings are
  restored. Newer publications, account changes and later external DNS/rule edits
  stop automatic restoration rather than being overwritten.
- Domain APIs enforce site admin, and zone onboarding requires organization admin.
  New MCP tools are classified as administrative operations.

### Verification evidence

- Actual production hosted `tools/list`, authenticated as the Moveria organization,
  already exposes `redirect_hosts` (array, max 4) and
  `accept_validation_window` (boolean). No domain write was sent. The new guide
  tools require this candidate's release and a subsequent hosted schema check.
- Synthetic 936-rule input expands to 1,170 static + 99 dynamic rules, exceeds
  128 KiB and passes direct upload. Oversized/count/line violations fail early.
- The real frozen static build fixture reuses all three unchanged pages for an
  origin change; every output file matches a clean full build byte for byte.
  All 14 partial-publication tests passed. This is not a Moveria benchmark.
- Coordinator regressions cover verified-artifact promotion with one build,
  automatic rollback after validation expiry, and manual rollback after success.
  Journal tests cover lost DNS/rule responses, external edits, changed TTL,
  superseded publications and repeated restoration.
- Nine focused browser journeys passed on the local built portal; screenshots
  inspected at 375, 768 and 1280 CSS pixels. API access tests verify read/write
  users and site keys cannot invoke administrative domain/zone operations.
- The complete local source gate passed: 276 shared, 3,115 portal and 1,615 MCP
  tests, script tests, typechecks, audits, builds, smoke and sealed docs. The final
  frozen-renderer selection change also passed all 43 coordinator tests. Exact
  committed-source CI qualification is recorded in the PR/release evidence; staging
  and production qualification have not happened for this candidate.

### Remaining deployment acceptance and limitations

1. Publish the approved Core/MCP candidate, pin it in Cloud, qualify staging and
   re-measure the UI and hosted connector. Production requires exact approval.
2. Update the organization build engine through its normal release contract.
   A new domain preparation retains published content but freezes the installed
   renderer revision. Its first run after a renderer/cache-format upgrade needs
   a full baseline; later compatible preparations can reuse it. Resuming an
   existing job never silently changes its renderer or content.
3. Measure an authorized Moveria preparation from a compatible baseline. The
   three-minute target and actual media/network savings remain unverified. The
   read-only production inspection found the latest production job live,
   with 262 pages rendered and `no_valid_cache`; its multi-day elapsed span includes
   approval/verification waiting and must not be reported as build duration.
   Render caches remain bounded at 32 MiB, and missing/expired/oversized or
   incompatible caches fall back safely to full rendering. This inspection did
   not establish which cache condition affected that older job.
4. After scoped approval, publish the restored complete redirect set, verify the
   real 449-URL inventory and only then remove the redundant provider Bulk list.
   No customer content, DNS, redirect lists or publications were changed here.
5. Source preflight counts configured redirects conservatively; the final build
   may omit rules shadowed by built pages. Remove obsolete shadowed rules at
   source near capacity. The application does not bypass Cloudflare's rule limits.
6. DNS scans cannot prove a complete inventory; mail/DKIM/other missing records
   must be checked against the previous provider before confirming the copy.
   This candidate supports scanning, not zone-file parsing. Nameservers, external
   DNS restoration and unresolved concurrent-edit conflicts remain manual.
7. The rollback contract restores DNS and cutover-created redirect rules, not
   arbitrary customer content or an older Pages artifact. It is not a general
   content-publication rollback tool. Empty ruleset containers may remain after
   deleting this switch's rule; unrelated rules are preserved. DNS propagation
   and an unavailable provider can delay restoration; the UI reports conflicts.

Provider API scan-list/scan-trigger contracts were rechecked against Cloudflare's
current API documentation on 2026-10-25. Synthetic provider tests are not a claim
of a completed real customer onboarding.
