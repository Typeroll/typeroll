# Large media migration and static delivery

Core 0.1.94 separates durable source transfer, private variant preparation and
static hosting delivery. WordPress source identities are indexed by a SHA-256
key scoped to the site; a leased transfer record stores attempts and completion.
Organization storage migration retains its cursor and per-file outcomes, verifies
copies before switching references, and drains independent siblings after failure.

Storage migration is one job per site (`publishing_media_migrations`, keyed by
organization and site). Site actions (upload, finalize, import retry) queue only
their own site. Only the first time organization storage
becomes ready does the organization job hand every site a job, in the worker,
with a resumable site cursor and time budget. Site media does not depend on the
organization's hosts: saving domains queues the organization job only when the
media host changes, and then it only attaches that host to the public bucket.
New keys for storage that was already ready, and a manual retry, restart failed
site jobs and redispatch queued jobs whose worker is gone; complete sites are
not read. A site pass requests a
preparation build only when it copied files, so unchanged sites never take a
build-engine slot. A queued organization-wide document from before per-site jobs
is handed to each site when the worker first runs it.

Transfer concurrency is bounded by file count, a byte reservation and source host.
Transient HTTP failures reduce concurrency; healthy transfers recover capacity.
Encoding uses a separate gate. Never increase encoding concurrency to compensate
for storage latency without measuring peak decoded-image memory.

Uploads and imports coalesce durable private preparation requests. Recovery runs
through the existing worker transport and scheduler. The selected customer engine
prepares at most 1,000 pending originals per task, with checkpoints every bounded
slice. Cache-only grants contain no public object upload URLs. Original and variant
cache keys remain in private R2. Draft preparation never creates a deployment.

The private cache namespace is recipe v2 and full source SHA-256. Its receipts also
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
Direct uploads follow the Cloudflare Pages limits of 20,000 files and 25 MiB per
file, with no total size limit (512 MiB before Core 0.2.150). Large outputs are
uploaded in runs of at most 256 MiB and 4,000 files and deployed once; legacy
encoded artifacts retain the 128 MiB limit.

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
preparation work. Deleted and unused files are excluded before grants and totals are created;
a dangling saved reference to deleted media fails explicitly. Older paths and
changed byte versions for still-used library records can remain retained in
their original storage/domain scope. Immutable conflict checks still apply.
This is not a second archive of every file ever published.

Build-side storage groups now admit up to sixteen small files, with a 200 MiB
reservation budget for original, comparison and verification buffers plus variant
overhead. Large/unknown files reduce the group automatically. Storage throttling
halves the next group capacity; healthy transfers restore it. Encoding keeps its
independent single-operation gate. This changes I/O scheduling, not image recipes.

Core 0.2.8 adds one immutable completion receipt per media entry,
written only after its original, variants and aliases have been verified. Its key
binds source bytes, storage and destination paths; its contents bind the encoder
recipe and variant hashes. Editorial changes do not invalidate it. A warm
preparation reads this small receipt without fetching originals, variants, aliases
or private-cache receipts, running image metadata inspection, or writing objects.
Changed paths or aliases require a new receipt and preparation. This relies on
immutable stored objects; it is not an exhaustive storage-availability audit.

Materialization then downloads each required original and variant once, verifies
its hash and writes local static output. Overlapping retained manifests reuse
verified local files. Missing or corrupt required bytes still fail publication.
Media delivered from a separate host without static inclusion needs no binary
downloads on this path. Older frozen renderers and grants keep their original
variant-receipt path. The first publication with the new renderer creates the
completion receipts; existing verified encodings are reused. No image files enter
Git and no image processing moves to the CMS request.

The supervisor releases its lease when the final preparation checkpoint reaches
the twelve-minute budget, even if all entries are ready. A fresh claim skips
preparation and has a full provider run for materialization, rendering and upload.
Small publications keep their existing lease. Completed private preparation can
return its small receipt immediately. Update existing shared engines for the
new final-checkpoint policy; frozen older renderers keep their own media behavior.


## Preview metadata and revision reuse

Core 0.3.53 forwards `listVersioned` through `timedStoreTransport`, so the
production Durable Object composition preserves raw preview collection reuse.
The same owner token (object epoch plus sequence) validates pure frozen-content
projections before reuse. Version, Site, Organization and all external projection
inputs remain in the key. The cache shares the collection cache's 16 MiB isolate
budget, refuses entries above 8 MiB, and expires projections after 15 minutes;
expiry never substitutes for owner validation. An unavailable owner fails the
read rather than serving stale content. Authentication and rendered HTML remain
outside these caches. Publications always capture a fresh consistent snapshot.

Responsive preview augmentation reads each referenced media record once, at most
eight at a time. `preview_responsive_media` covers that final stage independently
of HTML rendering. Missing legacy widths use the original image for the current
response. `waitUntil` retains bounded receipt hydration after the response, at
most four reads at a time with a 20-second admission budget; local tools await
the same maintenance. Concurrent previews share in-flight width reads. The same
best-effort hydration runs at preparation completion. Receipt failures leave
originals usable, and later views retry. Writes compare the immutable source
hash, so a late receipt cannot overwrite metadata for replacement bytes.

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

Core 0.2.37 shares `media-recipe.mjs` across grant issuance, preparation and
explicit API generation. The fixed `original` slot authorizes one exact object
per format even when dimensions are unknown before the customer runner reads
the source. Its srcset descriptor is the measured original width, never the
slot name. Only preset widths strictly smaller than the original are added.
Completion receipts use `.prepared-v2.`, private cache paths use `prepared/v2`,
and public variants use `.v2.`; prior v1 completions cannot bypass generation.
The original bytes and old public aliases are not overwritten or deleted.
The first v2 build prepares the new recipe; subsequent unchanged builds retain
the no-reencoding and no-unnecessary-download behavior.

## Readable public names (Core 0.3.49)

`lib/media/public-path.ts` allocates Site-scoped immutable names at first
publication, including standalone PDF publication. New ordinary uploads use
the filename in the media root; optional folders remain intact. WordPress
source paths lose their uploads/multisite prefix and preserve the remainder.
Explicit import filenames take precedence; editing a later display filename
does not move an existing assignment. Clearing public_path selects the current
filename again, including for an imported month folder.

A media record holds its allocation and earlier path/byte identities. Persistent
`media_public_paths` claims reserve decoded NFC-normalized paths against
other byte identities. Allocation uses the datastore's atomic compare-and-replace
with the claim as an effect, not an in-process lock. Different bytes/MIME types
receive numeric suffixes. Claims survive record deletion; legacy library paths,
known hash aliases and removal tombstones also protect earlier names. Dry runs
predict without creating claims. Do not edit these managed identities through
ordinary metadata PATCHes or mistake a content export for a full reservation
backup.

The frozen manifest carries safe earlier aliases and WordPress namespace
metadata. `media-path-redirects.ts` updates only targets proven to name the same
media and complete SHA-256, leaving authored storage unchanged. Managed WP
imports or an authored known mapping can declare the uploads prefix. Generic
borrowed URL imports cannot. Native prefix rules keep exact filename/status
exceptions; page-shadowing, unknown generated routes or exhausted dynamic
capacity fall back to known exact mappings. The existing Pages/Bulk planner
handles exact overflow without functions on customer sites. Ordinary name or
version changes do not generate one redirect per file. Unsafe-byte replacements
retain their separate redirect and verification policy.

Allocation does not make files public. Private object keys and responsive
variant suffixes still carry internal identities/recipe hashes. Preparation
receipts, public immutable-byte checks, host delivery verification and cleanup
ownership remain mandatory. Public editor/API guidance lives at
`packages/docs-site/src/content/docs/guides/media-for-editors.mdx`,
`tools/media.md` and `tools/redirects.md`; keep those and bundled agent help
in sync. Qualification includes an actual frozen static build accepted by an
older organization supervisor, since customers do not update engines on every
Core release.
