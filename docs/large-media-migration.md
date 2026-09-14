# Large media migration and static delivery

Core 0.1.94 separates durable source transfer, private variant preparation and
static hosting delivery. WordPress source identities are indexed by a SHA-256
key scoped to the site; a leased transfer record stores attempts and completion.
Organization storage migration retains its cursor and per-file outcomes, verifies
copies before switching references, and drains independent siblings after failure.

Transfer concurrency is bounded by file count, a byte reservation and source host.
Transient HTTP failures reduce concurrency; healthy transfers recover capacity.
Encoding uses a separate gate. Never increase encoding concurrency to compensate
for storage latency without measuring peak decoded-image memory.

Uploads and imports coalesce durable private preparation requests. Recovery runs
through the existing worker transport and scheduler. The selected customer engine
prepares at most 1,000 pending originals per task, with checkpoints every bounded
slice. Cache-only grants contain no public object upload URLs. Original and variant
cache keys remain in private R2. Draft preparation never creates a deployment.

The private cache namespace is recipe v1 and full source SHA-256. Its receipts also
bind the actual encoder versions and output checksums. When upgrading encoders or
transformation parameters, bump the recipe namespace in both the renderer and grant
generator, and the preparation record recipe. Never overwrite immutable variants.
Frozen publications retain their previous renderer and access contract.

The supervisor loops over batches within a 12-minute preparation budget, preserving
the lease between checkpoints. It yields with durable progress before provider
timeout. Failed attempts cannot finish after their token has been revoked.

Static delivery uses the pinned official Pages asset uploader in the trusted
supervisor with an asset-only JWT. Site source and renderer never receive hosting
credentials. The coordinator validates the manifest, preserves control files and
checksums, finalizes the exact project/branch/commit and verifies public response
bytes before traffic changes. The binary-artifact path remains for older runners.

Qualification must cover both build providers, a large mixed library, interrupted
source transfer and interrupted provider builds, 429 recovery, unchanged-file reuse,
private-cache access, branch isolation, changed domains, deleted routes and static
asset verification. Unit-test fixture durations are not production throughput
measurements. Record measured runtime and peak memory from real provider runs.

Object grants and final local materialization are issued in slices of at most 100
media entries. This prevents large libraries from putting every signed object URL
into a single claim response or grant document. Engines negotiate this capability
with the frozen renderer; older templates retain their original access path.
Direct uploads accept at most 512 MiB of static output, with 20,000 files and
25 MiB per file; legacy encoded artifacts retain the 128 MiB limit.

Shared Cloudflare claims prioritize waiting publications over private preparation
when a build slot becomes available. A running preparation retains its bounded
slice before yielding; this does not increase the provider's build concurrency.
GitHub claims remain bound to their authenticated dispatch.

The Cloudflare supervisor explicitly installs its locked trusted dependencies before
claiming work, even when automatic provider dependency installation is disabled.
Engine qualification verifies that the pinned uploader can start. Version listing
also normalizes Main when earlier publications stored only deployment metadata.

Retained media manifests contain only files or aliases not already covered by the
current output or an earlier retained snapshot. Caption edits do not duplicate
preparation work. Removed files, older paths, changed bytes and different storage
or domain scopes remain retained; immutable conflict checks still apply.

Build-side storage groups now admit up to sixteen small files, with a 200 MiB
reservation budget for original, comparison and verification buffers plus variant
overhead. Large/unknown files reduce the group automatically. Storage throttling
halves the next group capacity; healthy transfers restore it. Encoding keeps its
independent single-operation gate. This changes I/O scheduling, not image recipes.

Warm publication verifies the private receipt even when the public variant is
already available. Existing verified caches need no conditional write attempts.
A missing private cache is backfilled once from verified public bytes without
encoding again; cache bytes are verified when consumed.

After durable preparation completes, batched materialization is read-only: it
reads each source original and the required public variant/receipt pairs, checks
their hashes and writes local static output. It does not repeat alias checks,
private-cache reads, encoding or storage writes. Missing or corrupt prepared
variants fail instead of silently repeating preparation.

The supervisor releases its lease when the final preparation checkpoint reaches
the twelve-minute budget, even if all entries are ready. A fresh claim skips
preparation and has a full provider run for materialization, rendering and upload.
Small publications keep their existing lease. Completed private preparation can
return its small receipt immediately. Update existing shared engines for the
new final-checkpoint policy; frozen older renderers keep their own media behavior.


## Customer-owned static verification

The trusted supervisor runs a separate `static_verification` task after the
coordinator finalizes a static Pages candidate. Its frozen source includes the
candidate origin, publication identity and expected checksums. The task key is
namespaced from the original build key and verification source hash; it cannot
replace the build task or reuse a receipt for another candidate. Only an active
lease can checkpoint or complete, and cancelling the parent publication revokes
verification. No renderer or hosting API credential is needed by this task.

Each group drains up to eight HTTP responses with incremental SHA-256 hashing.
Checkpoints cover at most 100 responses; the runner yields at twelve minutes and
resumes through the normal Cloudflare/GitHub dispatch path. Its completion receipt
binds the publication, frozen verification source and completed count. Missing,
corrupt or stale response bytes prevent completion. Only robots.txt keeps a small
buffer to account for Cloudflare's existing managed-prefix exception.

Verification plans reuse identical successful checks only when the previous
completed publication used the same account, project, website host, domain
revision and control-file hash. Only the generated `X-Typeroll-Publication`
header is normalized; the publication marker is independently checked each time. New/changed files and removed routes are checked;
a missing previous proof forces a full first verification. The publication marker
is always checked. Reuse relies on the complete direct-upload manifest and
Cloudflare's immutable content-addressed asset storage; it is not a per-run
exhaustive availability audit of unchanged files.

The coordinator independently probes at most sixteen relevant responses, planning
at most 1 MiB in total and rejecting any response over 256 KiB or a batch over
1 MiB. It checks publication identity separately before enabling the public link.
It never downloads an entire new image library just to verify a shared publication.
Large page/media bodies are verified by the customer engine; coordinator probes
are explicitly a bounded sample. Existing legacy frozen jobs keep their original
path, with streaming public-response hashing to avoid full-file buffer copies.
Update shared engines before starting new publications on this release.
