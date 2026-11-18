# Page save throughput

Historical investigation: PR #229, Core 0.3.38 / MCP 0.45.144, 2026-11-17.
The follow-up candidate and its local-only status are recorded at the end. Customer report: a saved field-only PATCH took 20–30 s;
a single-ID batch read took 2–3 s. No customer Page was changed in this investigation.

## Evidence and scope

`page-save-throughput.test.ts` runs the real content-write, working-copy, revision,
version/authority and sharded SQL store layers with offline transports. The Page
has 100 blocks and two changed image fields. Baseline: main `909d38e3`.

| Store transport calls per save | Baseline | Candidate |
| --- | ---: | ---: |
| Single document reads | 37 | 7 |
| Transaction reads | 5 | 5 |
| Collection reads | 3 | 1 |
| Commits | 5 | 5 |
| Total | 50 | 18 |

The five transaction reads/commits retain working-copy, revision, content and
cleanup semantics. The remaining collection read is revision retention; Workers
keep that optional task alive with waitUntil outside the response's critical path.
Local transports take only milliseconds, so those timings cannot predict network
latency. This probe excludes API authentication, response projection and client
network time. It establishes avoidable round trips, not the measured contribution
of each step to the reported production delay.

A field-only write did not download/prepare media or build/preview a site. It did
repeatedly read the Page, schema and template, validate unchanged presentation,
compute unchanged routes and scan redirects/history. Changed HTML still sanitizes
and runs its SEO transform; changed blocks still validate normally, including a
pre-existing working copy committed by save:true.

## Changes and invariants

- Cache cloned document reads only within one content-write operation. Invalidate
  on writes; CAS always runs against current storage, including schema guards.
  No cache crosses a request or grants permission to a stale conditional write.
- Pure custom-field updates validate their schema and authority but do not walk
  unchanged body/template content. Route hygiene runs only if the resolved route
  changes; custom fields used in the route still participate.
- Save the pre-edit revision before the Page. Only retention pruning is optional
  background maintenance; no timer-based repeat save or new recurring job.
- Existing batch-write / batch_update_pages accepts up to 200 entries. Four writers
  bound store pressure, errors remain per row, duplicate IDs fail before writing,
  and field-only batches avoid reading the block registry. Recommend 20–50 entries.
- replace_media records one Site-wide library relationship, with dry run and undo.
  It does not rewrite Page content or change its editorial provenance/alt text.
  Same-Site, ready-target, cycle and CAS checks apply. Previews and normal frozen
  publications resolve URLs/aliases to the target identity and hash. Existing live
  output and domain-only frozen rebuilds stay unchanged. No bytes are copied.

## Release qualification still required

The candidate also measures actual single-Page GET/PATCH/PUT and batch read/write
requests at the outer middleware. Authenticated responses expose `Server-Timing`
and `X-Typeroll-Timing-Id`. Slow requests (>=1000 ms) log `page_api_timing` with
fixed phase labels, count/total/max milliseconds, actual Durable Object RPC counts,
RPC wait intervals and transaction conflict count. No document paths, identifiers,
content, tokens, cookies or error payloads enter those logs. Unauthenticated
requests get neither diagnostic headers nor timing logs.

`total_ms` excludes runtime startup/queueing before middleware and client network
time. Phase durations are inclusive; parallel batch metrics can exceed wall time.
`store_busy_ms` is the union of observed awaited RPC intervals, not their sum.
Detached key-use/audit writes and revision maintenance leave the timing context.
Use client DNS/connect/TLS/TTFB/total timings alongside the server headers. The
actual production 20–30 second breakdown is **not yet measured**; these diagnostics
must be deployed before an ordinary customer save can supply that evidence.

Local checks on Node 22.23.5 (the CI version): 4,897 Portal tests, 375 MCP tests,
3,661 shared tests, infrastructure/docs/template tests and static smoke scenarios
pass. The source/release-artifact gate also passes, including security audit,
typechecks, docs, full builds and frozen-publication upgrade checks. After fixing
the timing module's caller/runtime boundary, the entire Portal suite was rerun;
the remaining gate used `--skip-tests` to avoid repeating unaffected workspaces.
The concurrency test forces two opposing replacement transactions to overlap;
only one commits. The route test confirms that a field used in a route still
creates its 301 redirect. Neither test changes customer data.

The normal approved Core/Cloud release path remains. On staging, seed synthetic
content at representative size and compare
field-only PATCH, a 20–50 Page batch and one library replacement. Measure client
elapsed time and verify saved content/revisions, unchanged block IDs and live
publication dependencies. Do not benchmark by editing customer content without
specific authorization. Report staging/production timing separately from this
transport-call budget. No seconds-per-save promise is established by this note.

## Remote baseline and release blocker (2026-11-17)

The existing staging release, Core 0.3.37, source
`beb8d84e95ff9b0d40dded642eaf3f3d9961f04a`, was measured through the normal
authenticated public API. The disconnected `e2e-core` organization's synthetic
`e2e-customer-publishing` site received 20 temporary draft Pages, each with 100
prose blocks and two image-related custom fields. No customer content or live
publication changed.

| Operation | Samples | Client elapsed |
| --- | ---: | --- |
| Batch read with one Page ID | 3 | 452–514 ms; median 464 ms |
| Field-only PATCH with `save: true` | 5 | 2,422–2,662 ms; median 2,488 ms |
| Batch write with 20 saved field patches | 1 | 8,349 ms total |

Readback confirmed every changed field, unchanged block content/IDs and saved
revision history. All temporary Pages, the Content type and API key were removed.
These observations do not reproduce the customer's 20–30 seconds or isolate
server time: Core 0.3.37 has no request timing headers. Repeat this same shape
after the candidate reaches staging; do not infer an improvement from the local
transport-call counts alone.

PR qualification is blocked by the dependency audit:
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), reviewed
on November 17, affects `picomatch <=4.0.7`. At this check npm's latest version
was 4.0.7 and the advisory listed no patched version. Both Core and private Cloud
resolve affected transitive dependencies. Do not bypass the audit or treat the
earlier local gate as current security qualification. A dependency remedy and
passing CI are required before merge and release.

The owner subsequently approved an exception for the unchanged production risk.
The comparison, exact lock binding and December 1 expiry are recorded in
[security advisory exceptions](security-advisory-exceptions.md). Qualification
must still pass with that explicit exception before any release.

## Follow-up candidate: atomic Save and validated preview collections

Core 0.3.40 candidate (local only). The preceding sections are historical
measurements, not the release status of this follow-up.

- The same changed-field fixture now uses **12 transport calls: 7 get, 2 getMany,
  1 list and 2 commit**, versus 18/5 commits in 0.3.38. Ten fields in one saved
  patch use the same budget. This still excludes authentication and response work.
- The first transaction stages the draft. The second guards the Page, its schema,
  version dependencies and the exact draft, then saves the Page, pre-edit revision,
  provenance and draft deletion together. A newer draft causes a conflict without
  a partial Page write or orphan revision. Absent tombstones are only guarded;
  no standalone deletion commit is needed. Revision retention stays off the
  Workers response path. Address changes still run redirect hygiene.
- Preview collection reads may reuse raw data in the same store instance, bounded
  to 32 collections per store, 16 MiB / 64 entries across the isolate, and 8 MiB per entry. Each read asks the
  owning object for its current epoch/sequence. Unchanged replies contain only
  the token; any write/delete/expiry or object restart requires fresh collection
  bytes. Paths and query options separate sites, versions and filters. No rendered
  HTML, user authorization or ticket validity is cached. Cold or oversized
  collections still take the original full-read path. Node fixtures without the
  optional transport method retain ordinary reads.
- This avoids transferring/parsing unchanged libraries, not all per-click RPCs.
  An object-wide sequence deliberately invalidates more broadly than necessary.
  Page/template edits, changes in inherited versions and deletes remain visible.
- Editor refreshes coalesce for 120 ms and pause while Save flushes the draft and
  commits. Head-only metadata does not reload the visual canvas until explicit
  Save; standalone previews always render current saved metadata. HTML editor
  autosaves send changed fields instead of resending the body for a metadata edit.

Local throughput numbers are not production latency promises. Repeat authenticated
browser measurements after the separately approved staging/production rollout.

The real preview-route fixture with 50 Pages transfers 513,160 bytes for the
first Page-library read and 51 bytes on the next click with unchanged content.
A subsequent Page edit is immediately visible, and a deleted route disappears.
This measures that collection response, not the entire HTTP page or browser load.

Verification: the complete source test suites passed (4,921 Portal, 376 MCP and
3,668 shared tests, plus infrastructure/static smoke checks). Typechecks,
security audit, frozen-template compatibility checks, builds and docs artifacts
passed. Eleven distinct Chromium journeys cover draft recovery/navigation and
both editors' efficient saves. The final expiry-watermark change was rechecked
with 55 store/cache/scheduler tests and a rebuilt portal. Expired records keep
no individual deletion tombstone; a single expiry watermark invalidates caches
and concurrent snapshots. These are local results, not production measurements.
