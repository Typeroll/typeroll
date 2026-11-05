# Store migration runbook: Firestore to Durable Objects

This runbook moves an installation's document store from Firestore to the
Durable Object store (one object per site, one per organization, one global)
in a single maintenance window. It covers the data steps of the cutover; DNS,
smoke tests and the release itself follow the platform migration plan.

The tool is `scripts/migrate-store.mjs` over the library in
`packages/portal/src/lib/migration/`. The same library runs the production
import inside the portal Worker, because Durable Objects are reachable only
from there.

## What the tool guarantees

- **Export** walks every collection and subcollection (also below deleted
  parent documents) and writes one record per document as canonical NDJSON,
  ordered by path segment, so the same data always gives the same bytes.
  Documents are exported as stored: block trees stay gzip-wrapped, secrets stay
  encrypted. The manifest next to the file holds the record count and SHA-256
  per collection group and for the whole file; the file checksum equals
  `shasum -a 256` of the file.
- **Import** first checks the file against its manifest and refuses a damaged
  export. It creates every site's ownership row (and so its object), writes each
  document into its object, mirrors each site document into its organization
  and drains outboxes. It is idempotent and resumable from a checkpoint. It
  never overwrites a document whose current value differs from the record; it
  reports it as a conflict instead, unless `--force` is given. No scheduled work
  is delivered while importing.
- **Compare** re-reads every exported document from the target and compares
  the value a reader sees with the record after the transforms below. It
  reports counts per collection group and every missing or different document
  with the first differing JSON pointer, never the values. Any difference exits
  non-zero.

Transforms on import:

| Stored in Firestore | Stored in the object |
| --- | --- |
| `_tr_blocks_gz_` block trees, `_tr_nested_array_` and `_tr_snapshot_json_` markers | plain JSON; a document over 2,000,000 bytes decoded keeps its stored encoding and is listed under `compressed` |
| Timestamp | ISO-8601 string, millisecond precision |
| Bytes / GeoPoint / DocumentReference / NaN, ±Infinity | base64 string / `{latitude, longitude}` / path string / `null` |
| an `id` field equal to the document id | removed (every store returns the id); a different `id` is listed under `idMismatches` and shows up in the compare |

Dropped collections: `revoked_sessions`, `session_lineage` (replaced by Better
Auth database sessions), `auth_rate_limits` (short-lived windows),
`typeroll_system/deploy_queue/**` (the Firestore deploy queue), and from a
sharded export `_outbox` and `site_owners` (the target names its own objects).
The `scheduled_work` index is copied to the global object as it is.

Exit status: `0` clean, `1` conflicts, differences or a damaged file, `2` usage.

## Before the window

1. **Rehearse on a full copy.** Reading Firestore needs no freeze, so a
   rehearsal can run at any time:

   ```bash
   gcloud auth application-default login   # an account with roles/datastore.viewer
   export FIREBASE_PROJECT_ID=$GCP_PROJECT
   mkdir -p rehearsal
   node scripts/migrate-store.mjs export --source firestore --out rehearsal/store.ndjson --concurrency 32
   node scripts/migrate-store.mjs import --in rehearsal/store.ndjson --target local:rehearsal/objects --report rehearsal/import.json
   node scripts/migrate-store.mjs compare --in rehearsal/store.ndjson --target local:rehearsal/objects --report rehearsal/compare.json
   ```

   `local:DIR` keeps one SQLite file per object, split exactly like
   production. Then upload the same export to staging's migration bucket and
   run the Worker import and compare there (below). The exit criterion is zero
   differences on both. Note the export time, the record count and the file
   size; the window plan depends on them.
2. **Create the EU migration bucket** once, without a public domain:

   ```bash
   npx wrangler r2 bucket create $MIGRATION_BUCKET --jurisdiction eu
   ```

3. **Configure the target environment:** the portal Worker with its store
   objects (EU jurisdiction), `LEGACY_FIREBASE_SCRYPT` with the project's
   password hash parameters, and the migration bucket bound to the
   operator-only migration entry point.
4. **Check access:** `firebase auth:export` works for the project, and the
   account that changes IAM for the freeze has the rights to change it back.

## In the window

Times assume an export of a few hundred thousand documents; use the
rehearsal's numbers.

### 1. Freeze GCP (5 min)

Make Firestore read-only for every runtime identity and stop scheduled
delivery. Pause, never purge: pending work is in the `scheduled_work` index and
continues on Cloudflare.

```bash
gcloud scheduler jobs pause $SWEEP_JOB --location=$REGION --project=$GCP_PROJECT
gcloud tasks queues pause $TASK_QUEUE --location=$REGION --project=$GCP_PROJECT
# Repeat for each runtime service account that writes Firestore (portal, forms, operator, deploy worker).
gcloud projects get-iam-policy $GCP_PROJECT --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$RUNTIME_SA" --format='value(bindings.role)'
gcloud projects add-iam-policy-binding $GCP_PROJECT --member=serviceAccount:$RUNTIME_SA --role=roles/datastore.viewer
gcloud projects remove-iam-policy-binding $GCP_PROJECT --member=serviceAccount:$RUNTIME_SA --role=roles/datastore.user
```

Record the roles listed before the change; the rollback restores exactly
those. Confirm the freeze: an edit in the portal must fail, and no task runs.

### 2. Export (10–15 min)

```bash
export RUN=$(date -u +%Y%m%dT%H%MZ)
mkdir -p cutover/$RUN
FIREBASE_PROJECT_ID=$GCP_PROJECT node scripts/migrate-store.mjs export \
  --source firestore --out cutover/$RUN/store.ndjson --concurrency 32
firebase auth:export cutover/$RUN/users.json --format=json --project $GCP_PROJECT
node scripts/migrate-store.mjs verify --in cutover/$RUN/store.ndjson
shasum -a 256 cutover/$RUN/store.ndjson   # equals "sha256" in store.manifest.json
```

The export refuses to overwrite an existing file. `users.json` holds password
hashes: keep it on the operator's machine and in the migration bucket only.

### 3. Local check (5 min, recommended)

The same import and compare against local objects catch a transform problem
before anything touches production objects:

```bash
node scripts/migrate-store.mjs import --in cutover/$RUN/store.ndjson --target local:cutover/$RUN/local --report cutover/$RUN/local-import.json
node scripts/migrate-store.mjs compare --in cutover/$RUN/store.ndjson --target local:cutover/$RUN/local
```

### 4. Transfer to EU R2 (5 min)

```bash
for file in store.ndjson store.manifest.json users.json; do
  npx wrangler r2 object put "$MIGRATION_BUCKET/$RUN/$file" --file "cutover/$RUN/$file" --jurisdiction eu --remote
done
npx wrangler r2 object get "$MIGRATION_BUCKET/$RUN/store.ndjson" --file cutover/$RUN/check.ndjson --jurisdiction eu --remote
shasum -a 256 cutover/$RUN/check.ndjson
```

`wrangler r2 object put` uploads files up to 300 MiB. For a larger export use
the S3 API of the EU jurisdiction with an R2 API token scoped to the bucket:

```bash
aws s3 cp cutover/$RUN/store.ndjson "s3://$MIGRATION_BUCKET/$RUN/store.ndjson" \
  --endpoint-url "https://$CLOUDFLARE_ACCOUNT_ID.eu.r2.cloudflarestorage.com"
```

### 5. Import into the objects (10–20 min)

Call the operator-only migration entry point of the portal Worker for the run
until it reports `done`. Each call runs one bounded `importStep` (about 4 MiB of
records) against the objects and stores the returned checkpoint next to the
export (`$RUN/import-checkpoint.json`), so an interrupted import continues
where it stopped; rerunning a step is harmless. Then import the users from
`$RUN/users.json` (`importIdentityExport`) and read the identity report
(`created`, `existing`, `accountsCreated`, `skipped`).

The import must end with `conflicts: []` and `errors: []`. On a fresh target
a conflict means data was written to the objects outside the import: stop and
find out why before using `force`. `compressed` and `idMismatches` should be
empty; both were known from the rehearsal.

### 6. Read-compare (5–10 min)

Run the compare steps through the same entry point. The result must show zero
`missing`, `different`, organization-copy differences and `errors`, with
`equal + dropped = records`. Keep the compare report with the run.

Then continue with the platform switch: DNS, smoke tests and the first real
publications.

## Rollback

**Within the window, before the switch:** restore the recorded IAM roles,
resume the queue and the Scheduler job, and leave DNS on GCP. Nothing on
Cloudflare is served yet; a later attempt imports again into the same objects
(unchanged documents are skipped, documents changed on GCP in between show up
as conflicts and need `force`).

```bash
gcloud projects add-iam-policy-binding $GCP_PROJECT --member=serviceAccount:$RUNTIME_SA --role=roles/datastore.user
gcloud projects remove-iam-policy-binding $GCP_PROJECT --member=serviceAccount:$RUNTIME_SA --role=roles/datastore.viewer
gcloud tasks queues resume $TASK_QUEUE --location=$REGION --project=$GCP_PROJECT
gcloud scheduler jobs resume $SWEEP_JOB --location=$REGION --project=$GCP_PROJECT
```

**After writes start on Cloudflare:** GCP stays frozen and read-only for 14
days. It is a reference copy of the data at cutover, not a second live system:

- a document damaged after the cutover can be compared with, or restored from,
  its frozen original (`compare` against a fresh local import names it);
- a defect that makes the Workers unusable is fixed forward or rolled back with
  Workers versions; data stays in the objects;
- switching DNS back to GCP would discard every change made after the cutover,
  so it is a last resort that needs the owner's explicit approval, after
  exporting the objects with this tool for later reconciliation.

After 14 days, archive a final Firestore export and the Firebase user export in
the EU migration bucket and decommission GCP (plan phase 8). Delete
`users.json` from the operator's machine once the import is verified.

## Worker entry point

The production import runs inside the portal Worker, behind operator-only
authentication, on these library functions (`steps.ts`, `import.ts`,
`compare.ts`, `identity.ts`):

- `r2ByteSource(bucket, key)` reads the export by byte range;
  `verifyExport(readLines(object.body), manifest)` checks it in one streaming
  pass before the first step.
- `importStep(target, source, manifest, checkpoint, { maxBytes })` with
  `target = { store, transport }` built from the store object namespace
  (`transport(name)` wraps the stub for the object named `global`, `org:<id>`
  or `site:<uid>`), starting from `newImportCheckpoint(manifest, { force })`.
- `compareStep(shardedReader(target), source, manifest, checkpoint)` from
  `newCompareCheckpoint(manifest)`.
- `importIdentityExport(auth, text)` with the portal's Better Auth instance.

Checkpoints and reports are plain JSON and contain paths, never document values.
