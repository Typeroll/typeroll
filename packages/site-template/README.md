# @typeroll/site-template

The Astro SSG renderer. One `astro build` produces a fully static site for one customer.

## Content model

Core 0.2.0 uses one Page model for all content types, including articles,
checklists and ordinary pages. The renderer reads `pages/`, `content_types/`
and `page_templates/` from the selected version. Custom values live in
`Page.fields`; each Page owns its block body and can share a Page template.
URL patterns, explicit Page paths and publication status determine the generated
routes. Records without a detail URL can still supply listing/repeater data.

The native seed fixture demonstrates an article as a Page. Existing installations
require data schema 2 before this renderer runs; the renderer has no old item
store fallback. See [the content contract](../../docs/content-model.md) and
[the upgrade guide](../docs-site/src/content/docs/guides/unified-pages-upgrade.mdx).

## Inputs

Content comes from the same datastore the portal writes to — Firestore in production, a JSON fixtures tree for local dev. Selection is automatic; set `FIREBASE_SERVICE_ACCOUNT` for Firestore, otherwise fixtures.

Build-time env vars:

```
TYPEROLL_ORG_ID         which org's data to render
TYPEROLL_SITE_ID        which site under the org
TYPEROLL_VERSION_ID     version/branch to render (default main)
TYPEROLL_SITE_URL       the public site URL (sitemap/canonicals)
TYPEROLL_FIXTURES_DIR   override fixtures location (dev)
FIREBASE_SERVICE_ACCOUNT   JSON string; enables Firestore backend
```

## Layout

```
src/
├── layouts/BaseLayout.astro   Theme CSS variables, fonts, SEO, scripts.
├── components/
│   ├── SEOHead.astro          Meta tags + JSON-LD (escapes </script>).
│   ├── Header.astro           Renders the header partial.
│   └── Footer.astro           Renders the footer partial.
├── pages/
│   ├── [...slug].astro        Dynamic page render. HTML and block modes.
│   ├── sitemap.xml.ts         Published, indexable Page routes of every type.
│   ├── robots.txt.ts          From settings; default if empty.
│   └── 404.astro
├── lib/
│   ├── datastore.ts           Read-only fixtures/Firestore store.
│   ├── content.ts             getAllPages / getPartials / getSiteSettings.
│   ├── images.ts              Cloudflare R2 URL helpers (cdn-cgi/image).
│   └── sanitize.ts            sanitize-html config for customer HTML.
└── styles/
    ├── reset.css
    └── global.css             CSS custom property scaffolding.
```

## Page content modes

`[...slug].astro` renders both sanitized HTML pages and structured block trees.
Keep the shared block renderer, portal preview, and static output aligned when
changing either mode.

## Sanitizer

`lib/sanitize.ts` defines the policy. Permissive on tags and inline styles (customers author their own HTML), strict on scripts and unknown iframe hosts. The `BaseLayout` separately injects `settings.scripts_head / _body_end / custom_css` via `set:html` — those are the explicit trusted-script surfaces, NOT part of page body content.

## Don't drift from the portal preview

`packages/portal/src/lib/render-preview.ts` is a hand-written renderer that produces the same output as this package for HTML pages. If you change `BaseLayout` or how partials wrap content, mirror it there or the editor preview will diverge from the deployed site.

See the root [`AGENTS.md`](../../AGENTS.md) and [`docs/`](../../docs/) for the
bigger picture, especially the security model and data contract.
