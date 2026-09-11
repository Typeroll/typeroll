# Typeroll CMS documentation

This package owns the public Starlight documentation. Use **Typeroll CMS** as
the product name, describe AI agents generically, and keep client-specific
setup instructions scoped to the client that actually needs them.

## Build and verify

From the repository root:

```sh
npm run build:docs
npm run build:subdirectory --workspace=@typeroll/docs-site
npm run prepare:migration --workspace=@typeroll/docs-site
```

The default target remains `https://docs.typeroll.com/` in `dist/`. The explicit
subdirectory target is `https://typeroll.com/docs/`, written to the ignored
repository `temp/docs-subdirectory/` directory. Do not change the release target
until the destination host and coordinated redirect deployment are ready.

Every build runs an artifact check covering titles, canonical URLs, indexing,
sitemap, edit links, structured data, internal links, images and generated agent
documentation. Content links should be relative to their public page URL so they
work at either base. Use HTML `img` elements for relative public image URLs;
Markdown relative images are resolved against the source file by Astro.

`prepare:migration` creates a `temp/docs-migration/` directory containing a
static `main-host/docs/` overlay, a separate redirect-only artifact for the old
Cloudflare Pages project, a complete page redirect checklist and additions for
the destination host's root robots/llms files. It does not deploy anything.
Never replace the main website with this overlay or publish the whole migration
directory. The current release workflow intentionally continues to publish the
subdomain artifact until a coordinated cutover is approved.

The main host must serve `/docs/` directory indexes, redirect `/docs` to `/docs/`,
and return the docs 404 page with HTTP 404 for missing documentation. A robots
file below `/docs/` cannot replace the root host's robots policy. Update the
release workflow before enabling the old-domain redirects, so later releases
cannot restore the old site. Verify real HTTP redirects, query preservation and
Search Console separately after cutover.

## Screenshots

The editor screenshots use synthetic sample content in the real block editor,
captured at 1440×900 and 390×844. Refresh them when documented controls change;
do not use customer content, authenticated exports or secrets in public images.
