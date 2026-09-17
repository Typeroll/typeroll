# Native layout and export contract

Core 0.2.14 implements the shared layout wishlist (September 17, 2026): spacing,
heading scale, intrinsic images, full-bleed sections/heroes, 1024px navigation,
single list markers, field-list boolean presentation, block IDs and content
export preflight, and breadcrumb rhythm. CSS precedence is documented; automatic
cascade warnings and preview TTL changes are deferred. No site data is rewritten.

Canonical user/API guidance: packages/docs-site/src/content/docs/tools/blocks.mdx.
MCP recipes: tr-responsive and tr-page-template. Native starter compositions use
these Core definitions; explicit starter settings remain explicit choices.

CONTENT_WELL_CSS owns tokens and outer geometry for static BaseLayout and portal
preview. Block definitions own their inner geometry; author settings remain
explicit. Do not add site-name conditionals or copy FundraiserChart workaround
CSS into Core. Hero full-image is the explicit background-cover exception.

blockTreeInputError validates raw structures before ensureBlockIds normalizes
identities. Working-copy filtering clones the input before normalization.
assertContentExportable runs on the same resolved version used by export and
source freezing. Readiness uses this path too, without builds or media/provider
I/O; accepted jobs skip current-content readiness and retain their frozen source.

Evidence: core-layout-contract.spec.ts verifies all target widths, full-bleed
bounds, complete image geometry, heading-to-image gap, marker ownership,
1023/1024 navigation and explicit overrides. article-layout.spec.ts retains the
existing article/mobile regression suite. Unit tests exercise malformed trees,
recursive IDs, false/unset/zero, editable working copies and admission blocking.
