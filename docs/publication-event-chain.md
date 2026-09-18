# Publication event chain

Core 0.2.21 replaces recurring publication observations with persisted next-step
messages. A successful checkpoint immediately continues the same frozen job;
a completed or failed organization build records the next event in the same
Firestore transaction as its result. Queue delivery is at least once. The
publication identity, event generation, atomic claims and saved provider receipts
prevent duplicate messages from publishing different or repeated source.

Running builds have **no estimated restart deadline**. A lost heartbeat is an
execution failure, not permission to start another build. UI and API/MCP status
reads report that failure; a user can investigate the provider log and explicitly
retry publishing. Provider-request ambiguity retains the original dispatch
identity rather than blindly submitting a replacement.

The chain is: frozen source → Git commit → customer build → static deployment →
verification → domain readiness → live. A saved result belongs to the exact
publication, deployment and domain revision. Candidate verification, project
preparation, successful domain preparation and host cache refresh are reused
within that job. A changed domain revision requires a new prepared publication.

Authenticated media/verification checkpoints can release a batch and request the
next batch. This is an explicit continuation, not a guessed execution timeout.
The old attempt loses its authorization before the next claims the same task.
Actual transient errors retry the same work. Visibility checks without a provider
completion event use short increasing delays; they never rebuild source. The
existing maximum verification window ends with a visible error.

## Durable delivery and schedules

`scheduled_work` is a transactional outbox and secondary index. Source changes
and their index entry commit together in Firestore. It contains explicit future
page schedules, coalesced site publication requests, coordinator checkpoints,
and terminal build events. Running remote builds are absent from its due set.
A worker acknowledges only after the next event or terminal outcome is saved.
Old generations are harmless; a completion cannot overwrite a newer checkpoint.
A site blocked behind an active publication is resumed by that job's completion,
without shortening the configured auto-publish debounce for newer edits.

Cloud Tasks delivers each entry to the existing authenticated worker route. Its
retries re-deliver the **same event**, not a new build. An index-only recovery
pass repairs failed queue submission. `/api/internal/publish-sweep` retains its
operational address, but no longer traverses organizations, sites, pages or
publication histories when idle. The existing five-minute Cloud scheduler can
remain for delivery recovery and media recovery. It does not poll running builds.
The portable Firestore worker reads the same index. Local development uses
process timers; fixtures and local in-process execution are not production
crash-durability guarantees.

## Upgrade

Before enabling the new runtime, drain active publications on the old runtime.
Keep customer content and existing public URLs unchanged. Prepare existing page
schedules and pending auto-publication markers once:

```sh
node --experimental-strip-types scripts/reindex-publishing.mjs --project PROJECT_ID
node --experimental-strip-types scripts/reindex-publishing.mjs --project PROJECT_ID --apply --confirm-project PROJECT_ID
```

Use the deployment environment's existing Application Default Credentials; do
not put credentials in command arguments. The first command is read-only. The
second changes only missing derived index entries, transactionally re-reading
the current source and preserving entries written by the new runtime. Re-running
is safe. It does not dispatch builds, migrate content, copy media, or reset jobs.
The scan occurs only when this command is explicitly run, never on portal boot.
Run it after old writers stop and before new workers start consuming schedules.
New installations need no backfill.

Qualify duplicate delivery, a queue outage after result persistence, a result
arriving during a wait-state write, interrupted coordinator delivery, stale page
schedules and concurrent edits during site dispatch. Confirm that idle recovery
reads only the index, and that advancing time never restarts a running build.
