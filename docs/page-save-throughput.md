# Page save throughput

Status: local candidate Core 0.3.38 / MCP 0.45.144, 2026-11-17. Not released or
verified on production. Customer report: a saved field-only PATCH took 20–30 s;
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
