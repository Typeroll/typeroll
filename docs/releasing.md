# Releasing Typeroll OSS

Status: normative for maintainers of `Typeroll/typeroll`

Public `main` is the only OSS release source. A push starts `Tests`; a successful
run starts `.github/workflows/publish-mcp.yml`, which owns the complete release
train. Do not push `core-v*` or `mcp-v*` tags manually.

## Version the candidate

- Bump the root version and both Core literals together when portal, Forms,
  shared runtime, renderer, hosted MCP, or self-host behavior changes.
- Bump `packages/mcp-server/package.json` and `src/version.ts` together when the
  standalone MCP package or its shared contract changes.
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

## Parallel publication

After the exact `main` commit passes `Tests`, the release workflow runs these
steps:

1. verify the exact qualified documentation artifact, then validate versions,
   tags, and changed product scopes;
2. in parallel, build the Core image once, publish it by immutable digest,
   verify `/api/version`, then create `core-vX.Y.Z`;
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
candidate commit. A manual workflow dispatch is dry-run-only by default; a real
manual release also requires `RELEASE_TYPEROLL_OSS`. The npm trusted publisher
must remain bound to `publish-mcp.yml`.

Cloud must consume the manifest artifact from a successful completed train. It
must never reconstruct a release from a mutable tag or rebuild the public image.

## Documentation-only source checks

`source-check-plan.mjs` selects a short lane only for a push to public `main`
whose previous commit already passed the exact repository's `Tests` workflow.
The complete Git diff must contain only Markdown/MDX under `docs/` or
`packages/docs-site/src/content/`, or the named top-level Markdown guides.
Renames include both paths. Unknown paths, dependencies, CI changes, incomplete
history, missing baseline proof and pull requests all use the full source gate.

The short lane still installs locked dependencies, validates the release plan,
audits dependencies, checks documentation schema/types and formatting, builds
production docs and seals the exact artifact. It skips application tests,
application/browser builds and external customer-builder download probes.
Core and MCP versions remain unchanged; documentation work needs no Cloud rollout.
A docs-only CI success can serve as the baseline for the next docs-only delta.
The first change to this selection logic always receives full qualification.

## Qualified artifact reuse

For full candidates, source checks and Playwright run independently on isolated
runners after scope selection; both must pass before `Release OSS` can start.
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

The Core release job uses built-in version checks and its Docker build, without
a redundant host `npm ci`. An unchanged MCP package is verified in the registry
without reinstalling build dependencies or the publishing client.
