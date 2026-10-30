# Contributing

Use Node.js 22 or later and work from a clean checkout.

```sh
npm install
node scripts/oss-release-check.mjs
```

The check matches the main CI release gate, including documentation schema and
formatting checks, type checking, tests, builds, dependency audit, and version
planning.

Keep code, identifiers, routes, API fields, test names, and technical logs in
English. Never commit credentials, generated dotenv files, customer data, or
authenticated exports.

Changes to public contracts need tests and documentation. This includes Forms,
Extension manifests and tokens, REST/MCP tools, datastore paths, and generated
site output.

## Rendered output and render versions

Existing sites must not change appearance on a Core update. A change to block
markup or shared platform CSS that alters an existing page goes behind the next
render version: add it to `RENDER_VERSIONS` in
`packages/shared/src/render-version.ts` with a user-facing description, and
branch on `renderVersion` in the renderer or on `[data-tr-render]` in CSS.
`render-version-reference.test.ts` compares every core block and the shared CSS
with stored references per version and fails on unplanned output changes. Update
a reference (`vitest -u`) only for a genuine fix that restores intended output,
and say so in the changelog. Design: `docs/plans/design-system-and-render-versions.md`.

## Releases

Core and MCP are independently versioned but published by one ordered train.
Run `npm run release:bump` to bump the versions `npm run release:plan` asks for,
and push public `main`. After `Tests` passes, **Release OSS** publishes and verifies Core, then
MCP, then public documentation, and finally records the manifest consumed by
Typeroll Cloud.

Do not create release tags manually. A manual dry run is available through
**Release OSS** when artifacts need inspection without publication. The full
maintainer procedure is in `docs/releasing.md`.

### Change routine

The routine from change to published release:

1. Branch from an up-to-date `main` and commit as you go, one logical change
   per commit with its tests and documentation.
2. Before pushing, run the local gate and the portal browser suite in Chromium.
   CI runs that suite, but the local gate does not:

   ```sh
   git fetch origin --tags
   node scripts/oss-release-check.mjs --release-artifacts
   cd packages/portal && npx playwright test --project=chromium
   ```

   Run new browser specs in WebKit too. CI also runs Firefox for the specs in
   `CROSS_ENGINE_TESTS`.

3. Fetch tags and merge `origin/main` first: `main` may have released while
   the branch was open. Then run `npm run release:bump` and add a
   `CHANGELOG.md` entry. It bumps exactly the Core and MCP patch versions
   `release:plan` asks for in every version source, refreshes
   `package-lock.json` and prints the passing plan; it does nothing when the
   plan already passes. Do not edit version strings by hand. Use `--dry-run` to
   preview, and `--core x.y.z` or `--mcp x.y.z` for a minor or major bump. A
   new render version's `core_version` names the Core release that introduces
   it; the bump lands on that version and refuses a conflicting one.
4. Open a pull request. Merge it with a merge commit once every check is green.
   The repository does not allow auto-merge.
5. If main's tree is identical to a tree a pull request run fully qualified,
   main reuses that qualification and takes about a minute and a half (see
   [Pull request qualification reuse](docs/releasing.md#pull-request-qualification-reuse)).
   If `main` moved after the pull request's checks, main runs the full gate,
   which takes about seven minutes. **Release OSS** then publishes what the plan
   says.
6. Typeroll Cloud picks up the release manifest through its own release
   process. Cloud production needs explicit approval for each release.

When the dependency audit fails on a newly published advisory, it blocks every
pull request and `main` until it is fixed. Upgrade the dependency, preferring
the smallest fixed version, in its own pull request. A runtime dependency
change is a Core release. Add an entry to `APPROVED_ADVISORIES` in
`scripts/audit-dependencies.mjs` only with a rationale and an expiry, when no
fixed version can be used.

## Public documentation for Cloud and self-hosting

`packages/docs-site/` owns all public user documentation at
`https://typeroll.com/docs/`, including Cloud-specific user workflows. Private
Cloud implementation, credentials and operational runbooks stay in the Cloud
repository. Public documentation does not change a feature's license or service
availability.

For every user-visible change, check the affected editor, UI setup, API/MCP,
publishing, media, domains, versions, Forms, modules, Extensions and migration
guides. Use the public Cloud/self-hosting comparison as the navigation map.
Document shared behavior once; state Cloud and self-hosting differences in
availability, permissions, setup and runtime ownership beside the instructions.
Do not describe planned capabilities as available or promise undeclared Cloud
plans, quotas or service guarantees.

A Cloud-only change still needs its public guide updated here when its user
workflow changes. Coordinate publication with the Cloud rollout and clearly mark
any version or availability boundary. Add a new topic to navigation and the
comparison where relevant. The build generates HTML, individual text alternatives
and agent indexes from the same source; do not maintain separate copies.

For documentation-only changes, run `node scripts/oss-release-check.mjs --docs-only` and the documentation export tests. Run `npm run release:plan` to
confirm artifact scope. Documentation can be published without inventing new
Core or MCP versions; follow the normal release workflow and approval rules.

For content-model changes, also update `docs/content-model.md`, packaged MCP
`read_guide` and tool descriptions, bundled skills, `typeroll init` instructions,
site checklist, native starter fixtures and Extension-starter integration docs.
Retired content APIs must not remain in active examples or generated agent help.
Keep historical release notes explicitly historical and migration-only shapes
inside the offline migration.
