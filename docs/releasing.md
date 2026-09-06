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

Run before committing:

```bash
npm run release:plan
npm run security:audit
npm run typecheck
npm test
npm run build
```

The release plan includes committed, staged, unstaged, and new files. It fails
when product files changed after an existing tag without the corresponding
version bump.

## Ordered publication

After the exact `main` commit passes `Tests`, the release workflow runs these
steps serially:

1. validate versions, tags, and changed product scopes;
2. build the Core image once, publish it by immutable digest, verify
   `/api/version`, then create `core-vX.Y.Z`;
3. build and inspect MCP, publish with npm Trusted Publishing, verify npm, then
   create `mcp-vX.Y.Z`;
4. build and deploy public documentation from the same source commit;
5. upload `oss-upstream.lock.json`, containing the exact Core source commit,
   digest, Core/MCP versions, schema range, template capabilities, and Extension
   protocol/runtime versions.

An already released unchanged Core or MCP version is verified and reused. If an
image reached GHCR but the workflow stopped before creating its Core tag, a
rerun reuses it only when its embedded source revision exactly matches the
candidate commit. A manual workflow dispatch is dry-run-only by default; a real
manual release also requires `RELEASE_TYPEROLL_OSS`. The npm trusted publisher
must remain bound to `publish-mcp.yml`.

Cloud must consume the manifest artifact from a successful completed train. It
must never reconstruct a release from a mutable tag or rebuild the public image.
