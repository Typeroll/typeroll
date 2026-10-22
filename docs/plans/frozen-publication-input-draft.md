# Frozen publication input draft

Status: draft, not release-ready. Preserved from local work on 2026-10-22,
based on main `7cf7d94` (Core 0.2.87 / MCP 0.45.67).

## Purpose and boundary

Give an authorized derivation provider the same immutable public content and
configuration used by the static publication. A provider must not reread mutable
CMS records and then claim its result corresponds to an earlier content digest.
Core owns projection, transport, provider identity, validation and rendering
dependencies. Provider-specific business rules remain outside Core.

## Preserved implementation

- Project public Pages and Content types before invoking providers. Carry that
  content in the request and hash the projected records.
- Select the frozen provider release and its public configuration, require
  `content:read`, and reject inconsistent inputs.
- Introduce `input_format: frozen_publication_v1` in manifest admission and
  require providers to return exactly their declared sources, including empty
  sources.
- Allow bounded derivation requests/responses of 8/16 MiB while ordinary admin
  requests retain their existing limits.
- Include derived output and receipts in render-cache identity; preserve
  skipped-provider information.

## Verification on 2026-10-22

Against the preserved local draft:

- Portal derivation/provider/admin-transport suites: 41 tests passed.
- Shared Extension suite: 42 tests passed.
- Partial-publication suite: 11 tests passed, including real static builds
  compared with clean full output.
- Shared and Portal typechecks passed; Portal reported 143 hints and no errors.
- A temporary synthetic provider probe exercised public projection, content and
  configuration digests, provider output validation and render-cache keys.
  Draft, private-field and provenance sentinels were excluded. This was not an
  authenticated HTTP, approval, import or deployment test.

These are focused checks, not a completed release qualification. No versions
were bumped, artifacts published, customer data migrated or sites deployed.

## Required before merge or activation

1. Update the canonical Extension JSON schema, its public copy and generic
   contract documentation. The runtime validator now admits `build_derivation`,
   but the JSON schema still rejects it as an unknown property.
2. Replace global derived-output invalidation with dependencies on actual
   consumers. The probe changed one derived label and invalidated all 450 page
   cache keys. Add regressions for membership changes with unchanged counts,
   empty sources and unrelated pages retaining their cache entries.
3. Add committed integration coverage for provider admission, signed transport,
   identity/configuration changes, source completeness, size limits and failure
   handling. Existing unit passes do not qualify the new HTTP contract.
4. Exercise the real approval-to-publication path with synthetic data: approve
   Yes-to-No, clear another answer, rename a stable child record and change
   membership; verify all rendered consumers use the same accepted revision.
   Pending proposals and working copies must not leak. A later import must not
   overwrite accepted provenance or answers. Provider failure must leave the
   current live artifact intact. Cover both supported customer build backends.
5. Complete the normal release gate and coordinate the provider contract before
   selecting a release version. This draft is not authorization to activate a
   provider or publish customer sites.

Keep provider implementation, private app guides and customer conversion work
in their owning repositories. This branch contains only the generic contract.
