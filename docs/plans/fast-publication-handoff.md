# Fast publication handoff

Status: implemented and verified locally; release approval pending. No Cloud production rollout authorized for this change.

## Boundary

The CMS authorizes a publication, freezes a coherent public source revision and
its version/domain/toolchain identity, publishes generated source, and starts the
organization engine. The engine resolves authored URLs, prepares media, renders,
uploads and exhaustively verifies static output. The coordinator consumes bounded
receipts and probes. Neither building nor provider waiting holds an HTTP request.
GitHub and Cloudflare use the same source contract; generated repositories still
build independently without querying mutable CMS content. Images stay outside Git.

## Implementation and acceptance

- Move media and website reference resolution into the frozen renderer. Preserve
  canonical behavior, media aliases, branch hosts and domain preparation from
  older immutable renderers. Compile reference matching once, with exact URL
  boundaries and no cascading replacements.
- Freeze source once and persist immutable checkpoints. Read/write snapshot and
  renderer parts with bounded concurrency; never replace an accepted frozen
  revision with later editor content. Incomplete, unreferenced chunk generations
  cannot overwrite an accepted snapshot. Capture version reads in one read-only Firestore transaction, including branch
  inheritance and removals. The fixture backend captures an isolated in-memory view.
- Separate generated content records so a one-page edit does not resend unchanged
  renderer or page bodies to GitHub. Reuse unchanged Git blobs while preserving
  replacement semantics for removed/manual files. Preserve source integrity checks.
- Make each coordinator phase independently resumable. Renew ownership while a
  bounded operation is active, fence stale attempts, and yield between phases.
  Use fast continuations for completed coordinator phases and delayed observation
  for customer build waiting. Scheduled recovery enqueues; it never runs a whole
  publication inline. Do not increase server memory, concurrency or timeouts.
- Record per-stage timings and safe failure codes. Keep active coordinator attempt time distinct
  from customer build duration or expose secrets in diagnostics.
- Keep UI, API/MCP, public guides and internal operations documentation aligned.
- Prove stable source under concurrent edits, restart recovery, stale-worker
  fencing, both provider paths, domain/branch behavior, independent static builds,
  and a realistic 258-page/337-media benchmark. Full release checks follow focused
  regressions. Published production timings require an approved rollout.

## Measured baseline

The previous production job needed about 33 minutes, included two 900-second HTTP
504s and 14 coordinator attempts totaling 2,974.604 seconds. Its source was only
4,353,833 bytes (258 Pages, 337 media references). Build and verification artifacts
completed, but the final coordinator recorded an unclassified internal error.
Do not treat that duration as expected build performance.

A reproducible synthetic reference-resolution benchmark (258 Pages, 337 aliases,
3,351,429 bytes) took 3,575 ms before the change and 15 ms with compiled matching on
the local development machine. This is a local algorithm measurement, not a claim
about production handoff latency or a full explanation of the historical timeout.

## Implementation notes and rollout

Core 0.2.4 and MCP 0.45.4 carry this change. There is no data migration and no
change to customer credentials or build-runner protocol. Old frozen renderers
retain their original monolithic source layout and eager domain retargeting.
New frozen renderers include the content index and deferred reference resolver.
Rollback must keep those renderer templates and snapshots intact. Once a new
publication has used snapshot format 1, an older binary cannot read that site's
last-publication checkpoint, even after its job finishes. Roll back with a Core
patch that retains the format-1 reader, rather than swapping directly to 0.2.3.
No bulk content migration or rollback of customer website files is needed.

The CMS still reads the selected public source and validates its security boundary
on each new publication. It does not maintain a second on-save content database
or claim dependency-safe partial HTML builds. Git reuses unchanged content blobs;
the organization engine receives a complete frozen source bundle and renders the
whole site. Source projection remains linear in site content, with no image-byte
transfer through the CMS.

Local benchmark: `node scripts/benchmark-publication-handoff.mjs` uses 258 pages,
337 media aliases and 3.35 MB of synthetic source. Compiled reference resolution
measured 16 ms, record serialization and hashing 7 ms. Editing one page changed
one 12,960-byte record; publication metadata and integrity manifests also change
in an actual deployment. These numbers exclude datastore and provider latency.

Regression checks cover explicit phase yielding, immutable retries, exact media
URL resolution, domain-only preparation after library deletion, branch isolation,
stale-owner fencing before Git writes, queued GitHub/Cloudflare observation,
transient provider retry limits, immediate Firestore continuation, real Git blob
reuse and removal, and an independent Astro build from split source. Removing the
freeze checkpoint and replacing snapshot reads with live reads both caused their
respective regression tests to fail; the implementation was restored afterward.

Before Cloud production rollout, publish this exact Core/MCP candidate, pin its
verified release manifest in Cloud, qualify staging and the permanent self-host
target, then promote the identical Cloud candidate. Verify a narrowly approved
site publication with per-checkpoint logs and external build timestamps. Do not
restart or republish real sites automatically as part of the implementation task.

## Final local evidence (2026-09-16)

- `node scripts/oss-release-check.mjs`: passed, including version planning,
  dependency audit, public docs checks/formatting, workspace type checks,
  2,773 tests, immutable publication-template generation and all workspace builds.
- Independent generated Astro builds exercise split source and deferred domain
  resolution, including main/branch templates, empty sites and public runtime.
- Scheduled recovery skips recent observations, active leases and human cutover
  approval; only abandoned observation chains are re-enqueued.
- No remote push, Cloud deployment, customer publication, DNS change, credential
  change or content migration was performed for this implementation.
- Cloud remains pinned to Core 0.2.3 / MCP 0.45.3 until the matched rollout.
