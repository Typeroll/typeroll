# Public documentation review — 2026-10-16

Baseline: public Core `532ca240678366dc6f0116e4b63380150f2b21d2`
(Core 0.2.77 / MCP 0.45.59). This is a documentation change, not a runtime
release, customer publication or Cloud deployment.

## Coverage and changes

The public documentation contains 72 content pages after this review. The
navigation covers onboarding, Cloud/self-hosting, editor and working copies,
Pages and Content types, block authoring, templates and reuse, styles, media,
publishing and domains, migration, Core modules, Extensions, MCP/REST and SEO.
The old `guides/apps-and-analytics` URL remains a short pointer to the module
guides; it is intentionally absent from navigation.

| Area | Evidence checked | Documentation result |
| --- | --- | --- |
| Built-in blocks | `CORE_BLOCK_TYPES` and its imported registries | Complete catalog: 77 distinct IDs, names and purposes; context-specific form/template blocks distinguished |
| Custom types | Shared definition validator, MCP block-type tools, portal block builder | Step-by-step composed callout, HTML alternative, validation/preview, permissions, scripts, usage, field renames and export |
| Page templates | Template starters/service, MCP template/type tools and portal template components | Creation, content slot, dynamic fields, status, type default, Page override, selected version and publication |
| Content reuse | Existing global-block/block-template contracts | Clear distinction between a reference, copied section and reusable type; correct partial inclusion rules |
| Availability | Current released source and account flow | Open-beta entry; remove obsolete future-release wording for implemented behavior without inventing older minimum versions |
| SEO | `SEOHead.astro`, shared SEO policy, sitemap/robots/text generators and current domain guide | Current domain preparation/cutover; independent index/follow; homepage-only Organization/WebSite schema; safe direct field mappings; realistic discovery limits |
| Navigation and agents | Starlight sidebar, generated HTML and text exports | New guides linked from homepage/sidebar/references; publication checks discoverable; empty Recipes group removed |

Private Typeroll Apps remain outside the public documentation. The generic
installation and authorized documentation-discovery contract remains public.
No legacy collection editor/API is introduced. Cloud-specific publishing setup
is distinguished from shared CMS behavior.

## Verification

- `node scripts/oss-release-check.mjs --docs-only`: schema, Astro check,
  formatting, static build and artifact validation.
- `npm run test --workspace=@typeroll/docs-site`: six agent-export and live-check
  tests.
- Built artifact: 73 HTML files including 404; 72 agent-readable pages;
  canonical, sitemap, structured-data, source-link, asset and internal-link
  checks. Separate scan of 2,071 fragment links found no missing anchor targets.
- Catalog IDs compared with the executable built-in registry: all 77 appear
  exactly once, with no invented types.
- The callout definition passed `validateBlockTypeDefinition` without errors
  or warnings and rendered both field bindings through the shared renderer. MCP template/type examples were checked against tool schemas.
- Local built-documentation browser review: homepage, concepts, catalog, both
  tutorials and SEO at 390, 768 and 1440 pixels, plus mobile sidebar navigation
  and search. Catalog entries use readable lists rather than a wide table.

This review checks documentation and local rendered artifacts. It is not an
end-to-end requalification of authenticated CMS, provider setup, email,
migration or customer publication flows. Cloud availability remains tied to
its deployed Core, and Site render versions can retain older behavior.

The ordinary checkout contains unrelated uncommitted runtime changes. The
unfiltered `npm run release:plan` correctly refuses those changes under an
already-published version. They are excluded from this documentation commit;
the release planner applied to the documentation delta requires neither Core
nor MCP publication. CI assesses the clean PR revision separately.

## Keep the docs current

When adding or removing a built-in type, update `guides/block-library.mdx`,
including its versioned count, and verify against `CORE_BLOCK_TYPES`. For new
settings, update the focused reference and a tutorial only when the workflow
changes. Keep type IDs separate from instance IDs.

Before a release, replace temporary “next release” claims with verified version
boundaries. Preserve useful existing anchors or update inbound links. New public
guides must be discoverable through navigation and the generated agent index.
The documentation checklist in `CONTRIBUTING.md` remains the release standard.
