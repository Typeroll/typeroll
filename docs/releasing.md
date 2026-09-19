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

Install dependencies once, then run the single release-candidate check before
committing:

```bash
npm ci
git fetch origin --tags
node scripts/oss-release-check.mjs
```

Refresh release tags before the local check so it sees the same published
versions as CI. Changes under `packages/shared/`, including the Core runtime
version, also require a new MCP version.

This is the same fail-fast check run by `Tests`: release planning, dependency
audit, documentation schema and Astro checks, formatting, type checking, tests,
and all workspace builds. The release plan includes committed, staged,
unstaged, and new files. It fails when product files changed after an existing
tag without the corresponding version bump.

## Parallel publication

After the exact `main` commit passes `Tests`, the release workflow runs these
steps:

1. validate documentation formatting and its production build, then validate
   versions, tags, and changed product scopes;
2. in parallel, build the Core image once, publish it by immutable digest,
   verify `/api/version`, then create `core-vX.Y.Z`;
3. in the same parallel phase, build and inspect MCP, publish with npm Trusted
   Publishing, verify npm, then create `mcp-vX.Y.Z`;
4. in the same parallel phase, build and deploy public documentation from the
   exact source commit;
5. after all three outputs succeed, upload `oss-upstream.lock.json`, containing
   the exact Core source commit,
   digest, Core/MCP versions, schema range, template capabilities, and Extension
   protocol/runtime versions.

The publishing jobs do not repeat the complete audit, type, unit, integration,
and workspace-build gate that the exact SHA already passed in `Tests`. They keep
their artifact-specific proofs: Core version and container runtime checks, MCP
package build and dry-run inspection, and the documentation production build.

An already released unchanged Core or MCP version is verified and reused. If an
image reached GHCR but the workflow stopped before creating its Core tag, a
rerun reuses it only when its embedded source revision exactly matches the
candidate commit. A manual workflow dispatch is dry-run-only by default; a real
manual release also requires `RELEASE_TYPEROLL_OSS`. The npm trusted publisher
must remain bound to `publish-mcp.yml`.

Cloud must consume the manifest artifact from a successful completed train. It
must never reconstruct a release from a mutable tag or rebuild the public image.

The documentation preflight is deliberately repeated at the start of the
release workflow before Core or MCP can run. The later documentation job uses
the same command. A formatting or build error therefore cannot leave a
partially completed release train.


## Qualified artifact reuse

Source checks and Playwright run independently on isolated runners; both must
pass the same source before `Release OSS` can start. A third early job downloads
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
