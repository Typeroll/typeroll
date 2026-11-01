# Releasing Typeroll OSS

Status: normative for maintainers of `Typeroll/typeroll`

Public `main` is the only OSS release source. A push starts `Tests`; a successful
run starts `.github/workflows/publish-mcp.yml`, which owns the complete release
train. Do not push `core-v*` or `mcp-v*` tags manually.

## Version the candidate

Run `npm run release:bump` once the candidate's changes are complete. It reads
`npm run release:plan`, bumps Core and/or MCP by a patch (or to `--core` /
`--mcp`), keeps every version literal and the lockfile in lockstep, aligns Core
with a newer render version, and prints the passing plan. `--dry-run` shows the
change first.

- Core changes when portal, Forms, shared runtime, renderer, hosted MCP, or
  self-host behavior changes.
- MCP changes when the standalone MCP package or its shared contract changes.
- Documentation-only changes need no package version bump.

Install dependencies once and run focused checks during development. For broad
changes, release infrastructure or unresolved risk, run the complete local gate:

```bash
npm ci
git fetch origin --tags
node scripts/oss-release-check.mjs
```

Refresh release tags before the local check so it sees the same published
versions as CI. Shared contract changes require a new MCP version; changing only
`packages/shared/src/release.ts` does not change the standalone MCP package.

This is the same fail-fast check run by `Tests`: release planning, dependency
audit, documentation schema and Astro checks, formatting, type checking, tests,
and all workspace builds. The release plan includes committed, staged,
unstaged, and new files. It fails when product files changed after an existing
tag without the corresponding version bump.

### Upgrade from earlier releases

`scripts/publication-upgrade-check.mjs` runs after the tests. Media preparation
leaves variants and receipts in each customer's R2 bucket, and every later
release must read them. For the three newest earlier `core-v*` tags, the check
prepares and publishes a small media library with that release's media code and
its own locked `sharp` and S3 client (installed into a temporary cache when they
differ), then publishes the same library with this source. It fails when the
upgrade cannot publish, when a published file changes bytes, or when media is
prepared again under the same `MEDIA_RECIPE_VERSION`. A deliberate recipe change
bumps that version; it is then prepared again under new keys and still passes.
Core 0.2.72 would have failed it: the sharp 0.35.5 update rejected every receipt
0.2.71 had written. Check a specific release with `--from core-v0.2.71`. The
check needs the tags and network access to install an earlier release's runtime.

## Parallel publication

After the exact `main` commit passes `Tests`, the release workflow runs these
steps:

1. verify the exact qualified documentation artifact, then validate versions,
   tags, and changed product scopes;
2. in parallel, take the Core image `Tests` prebuilt (or build it once), verify
   `/api/version` for its immutable digest, point the `core-vX.Y.Z` image tag
   at that digest, then create the `core-vX.Y.Z` Git tag;
3. in the same parallel phase, build and inspect MCP, publish with npm Trusted
   Publishing, verify npm, then create `mcp-vX.Y.Z`;
4. in the same parallel phase, deploy the already built documentation from the
   exact source commit;
5. after all three outputs succeed, upload `oss-upstream.lock.json`, containing
   the exact Core source commit,
   digest, Core/MCP versions, schema range, template capabilities, and Extension
   protocol/runtime versions.

The publishing jobs do not repeat the complete audit, type, unit, integration,
and workspace-build gate that the exact SHA already passed in `Tests`. They keep
their artifact-specific proofs: Core version and container runtime checks, MCP
package build and dry-run inspection, and documentation artifact integrity.

An already released unchanged Core or MCP version is verified and reused. If an
image reached GHCR but the workflow stopped before creating its Core tag, a
rerun reuses it only when its embedded source revision exactly matches the
candidate commit.

### Core image prebuild

On a push to `main` whose `release:plan` publishes Core, `Tests` builds
`ghcr.io/typeroll/typeroll:sha-SOURCE_SHA` in parallel with qualification. That
job alone has `packages: write`; the workflow default stays read-only. Pull
requests and commits that publish no Core never build, and `Tests` creates no
release tag. A failed image build fails `Tests`, just as it would fail the
release.

Both callers use `.github/actions/core-image`, so labels, the
`TYPEROLL_SOURCE_SHA` build argument, platform, BuildKit cache, SBOM and
provenance cannot drift. The prebuild job records the digest it pushed as the
`core-image-SOURCE_SHA` artifact of that `Tests` run. When `core-vX.Y.Z` does
not exist yet, the release job downloads that record from the qualified main
`Tests` run and reuses only `ghcr.io/typeroll/typeroll@DIGEST`, never whatever
`sha-SOURCE_SHA` currently points at: any workflow with `packages: write` can
move a tag or forge labels, but cannot change another run's artifact. The image
at that digest must still carry the source SHA and release tag labels. The job
verifies the container contract for that digest, points the release image tag at
the same digest with `crane tag`, and the manifest records it. A missing record,
other labels or any registry error builds exactly as before. When a record
exists, an existing `core-vX.Y.Z` image must point at the recorded digest.

`publish-mcp.yml` has no default token permissions; each job requests only what
its steps use (`contents: write` only for the Core and MCP tag pushes,
`packages: write` only for Core, `id-token: write` only for npm Trusted
Publishing). External actions are pinned to full commit SHAs with the release
tag in a comment; update the SHA and the comment together. The documentation
deployer is installed from the same `uploader-lock.json` as customer static
uploads, with `npm ci --ignore-scripts`.

A manual workflow dispatch is dry-run-only by default; a real
manual release also requires `RELEASE_TYPEROLL_OSS`. The npm trusted publisher
must remain bound to `publish-mcp.yml`.

Cloud must consume the manifest artifact from a successful completed train. It
must never reconstruct a release from a mutable tag or rebuild the public image.

## Documentation-only source checks

`source-check-plan.mjs` selects the documentation lane for:

- A push to public `main` whose previous commit passed this repository's exact
  `Tests` workflow.
- A same-repository pull request targeting `main`, whose tested merge has the
  event's exact base and head commits as its two parents, and whose base passed
  the same successful `main` workflow. The checkout must match that tested merge.

Both paths inspect the complete Git diff against the qualified baseline, not a
PR label, title or changed-file summary. Only Markdown/MDX under `docs/` or
`packages/docs-site/src/content/`, or the named top-level Markdown guides qualify.
Renames include both paths, including runtime files moved into documentation.
Unknown paths, dependencies, CI changes, docs components/styles/configuration,
incomplete history, missing or failed baseline proof and fork pull requests use
the full source gate, unless a main push qualifies for full PR reuse below.
If main moves after PR qualification, its push checks its own complete delta;
PR documentation success is never accepted as proof of full source qualification.

The short lane still installs locked dependencies, validates the release plan,
audits dependencies, checks documentation schema/types and formatting, builds
production docs and seals the exact artifact. It skips application tests,
application/browser builds and external customer-builder download probes.
Core and MCP versions remain unchanged; documentation work needs no Cloud rollout.
A docs-only CI success can serve as the baseline for the next docs-only delta.
A change to this selection logic is never documentation-only, so it always
receives full qualification, in its pull request run or on `main`.

## Merge an approved documentation candidate

Keep the pull request and the user's production approval. An explicit request
such as "merge PR 76" authorizes merging that reviewed candidate and its normal
automatic docs publication; do not ask for the same approval again after checks.
For an approved candidate, wait for its checks and merge with an exact head guard
in one operation rather than manually polling individual jobs:

```sh
# Set PR and APPROVED_SHA to the reviewed number and full 40-character head SHA.
gh pr checks "${PR:?Set the approved PR number}" --repo Typeroll/typeroll --watch --interval 30 &&
  gh pr merge "$PR" --repo Typeroll/typeroll --merge --delete-branch \
    --match-head-commit "${APPROVED_SHA:?Set the approved full head SHA}"
```

Run through the documented release credential profile. A failed check or changed
head stops the merge; never use `--admin` to bypass checks. This bounded operation
needs no repository-wide auto-merge setting and cannot silently approve a later
head. GitHub's persistent `--auto` setting is not a durable approval for an exact
commit: new commits require a fresh scope review. Keep automatic branch deletion,
then fast-forward the ordinary local checkout and remove its merged branch.

After merge, the existing main docs lane seals the artifact for the merge SHA;
the normal release workflow publishes it and verifies that exact SHA live.
Check both the HTML guide and its agent-readable `index.txt` when text changed.
No separate Core/MCP version or Cloud deployment is needed for documentation-only
changes. Do not report a merge as a completed docs deployment.

## Pull request qualification reuse

A push to `main` whose Git tree is byte-identical to a tree that a pull request
run already fully qualified counts as the exact source. Because the tree includes
`.github/`, both runs used the same workflow definition. For `pull_request`
events `GITHUB_SHA` is the test merge commit, which the run API does not expose,
so a same-repository full-lane run uploads `pr-qualified-TREE` (kept 7 days)
from `Select source checks`. It records that commit, its tree and a hash of the
`core-v*`/`mcp-v*` tags the run saw. Recording never fails a pull request; a
missing record only costs the full gate on `main`.

`source-check-plan.mjs` on `main` looks the record up by its own tree and selects
the `reuse` lane only when every check holds:

- the record's run is a completed, successful `pull_request` run of
  `.github/workflows/test.yml` in this repository from a branch of this
  repository, not a fork;
- the record is version 1, from the full lane, names this repository, this
  tree and the release tags `main` sees now;
- `git/commits/SHA` on GitHub returns the recorded commit with this tree and
  the run's pull request head as a parent.

A run that is still finishing is awaited for up to one minute. Any API or
download error, expired record, failed, cancelled or running run, fork, other
workflow file, different tree (main moved after pull request CI) or tag change
(a release happened in between) selects the full gate. Pushes without a
qualifying record, including those that fail the documentation-only rules,
also run it.

The `reuse` lane skips the release-candidate check and Playwright, which already
passed for this tree. It still verifies the pinned build dependencies, and runs
the documentation lane (`release:plan`, `security:audit`, docs checks and
build) to seal `docs-SOURCE_SHA`, because the artifact and its `release.json`
name the `main` commit. The successful `push` run for the exact SHA remains the
proof `Release OSS` requires, and it can serve as the baseline for a following
documentation-only push.

## Qualified artifact reuse

For full candidates, source checks and Playwright run independently on isolated
runners after scope selection; both must pass before `Release OSS` can start.
Playwright is split into four shards, each with its own server and fixtures,
and the required `Playwright e2e` check passes only when every shard passed.
The release check runs as `oss-release-check.mjs --skip-tests` beside two source
test jobs (infrastructure and workspace tests); the required `Release candidate
check` passes only when the build and both test jobs passed. Locally the script
without `--skip-tests` remains the complete sequential gate.
A third early job downloads
the pinned Bubblewrap archive and AppArmor profile, rejects redirects/oversize
responses, and verifies their exact hashes. Availability failures stop before
immutable publication, without changing runtime integrity requirements.

The source gate runs `oss-release-check.mjs --release-artifacts`. Its one workspace
build uses the `/docs/` target, then `prepare-migration.mjs --reuse-build` assembles
the deployment overlay. `release-artifact.mjs` records source SHA, lockfile hash,
exact Node version, target and a hash inventory including every generated file. CI uploads
`docs-SOURCE_SHA` for 30 days. This artifact contains public files only.

Release planning resolves a successful `Tests` push on `main` for that exact
source and repository. Both automatic and manual release require this proof;
manual dispatch does not bypass source qualification. Planning and docs deployment
verify the downloaded inventory and identity. Neither rebuilds documentation or
installs its build dependencies. Deployment still verifies the published source
marker and public routes. Expired or absent artifacts fail explicitly; qualify the
source again instead of silently building untested files during publication.

Core images use a scoped BuildKit cache to reuse layers, while immutable digest,
source-label and container-contract checks remain authoritative. Cache contents
never substitute for those checks. Workflow/helper-only changes are explicitly
classified as release infrastructure and do not require a fictitious Core/MCP
version bump; changes to runtime source still do.

The Core release job uses built-in version checks and the prebuilt image or its
own Docker build, without a redundant host `npm ci`. An unchanged MCP package is verified in the registry
without reinstalling build dependencies or the publishing client.
