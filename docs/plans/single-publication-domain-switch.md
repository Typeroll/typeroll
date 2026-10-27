# Single-publication domain switch

Decision: 2026-10-27. Implementation candidate: Core 0.2.116 / MCP 0.45.87.
Not deployed. Supersedes the parallel candidate-branch and repeated-preparation
requirements in earlier domain plans and Ulvön F35/F42 notes.

## Contract

- Saving future domains records intent only. Normal editing, preview and
  publishing continue at current/temporary addresses.
- Explicit **Publish for the new domain** (`prepare_publishing_domain_change`,
  guide action `prepare`) retargets the last public snapshot, excluding newer
  unpublished CMS edits, with the installed renderer. It replaces main at the
  current address. There is no extra domain branch or separate old served copy.
- `desired` is saved intent; `published` is the main artifact's embedded origins
  and publication ID; `active` is the verified traffic destination.
- Ordinary publication after that action retains the embedded origins and
  refreshes the main receipt while DNS is pending. Saving other future hosts
  does not silently change the current output.
- Separate DNS approval uses the exact current receipt. It does not push Git,
  build or upload a second time. The runner and approval share a publication
  target lock. Content publication waits while DNS activation is running.
- Certificate checks, reviewed DNS fingerprints, redirect validation and explicit
  acceptance of any validation interruption remain required. External DNS remains
  the administrator/agent's responsibility. Setup refresh does not rebuild main.
- DNS rollback restores DNS only, never old content. A new explicit attempt has
  a fresh approval/journal identity; retries of that attempt retain their identity.
- Old media aliases and frozen manifests remain available. New-host absolute
  links can wait for DNS/certificates, so perform the explicit publication just
  before switching DNS. Do not promise that all links work on both hosts then.
- Older preview-branch preparations are rejected and need one explicit main
  publication. No old candidate is automatically promoted during a Core upgrade.

## Verification and rollout

Runner fixtures exercise one main push/build/upload, DNS-only continuation,
normal edits before DNS, later desired-host edits, stale approval, provider
failure, target reservation races, validation windows and rollback. Portal checks
cover explicit publication copy, noindex warnings and DNS approval on phone and
desktop. Public docs, MCP descriptions and the starter migration workflow share
this contract. Render version stays 11; this changes coordination, not rendering.

Production rollout requires the normal exact Core/MCP candidate approval and
Cloud staging qualification. No customer publication or DNS change is implied
by this implementation. Existing live sites need no automatic migration.
