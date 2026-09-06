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
node scripts/oss-release-check.mjs
```

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
