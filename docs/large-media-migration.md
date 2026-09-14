# Large media migration and static delivery

Core 0.1.87 separates durable source transfer, private variant preparation and
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
