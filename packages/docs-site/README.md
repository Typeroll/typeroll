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
repository `temp/docs-subdirectory/` directory. The release workflow publishes the subdirectory artifact as Cloudflare Workers
Static Assets, then redirects the previous Pages domain after verifying it.

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
directory. The release workflow preserves the order: publish static assets, verify the
new destination, publish old-domain redirects, verify redirects.

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

## Agent-readable documentation

Every build emits `llms.txt` as an index, `llms-full.txt` as complete Markdown,
`llms-small.txt` as the shorter set, and an `index.txt` beside every page's
`index.html`. The HTML head advertises the index and per-page text with
`rel="alternate" type="text/plain"`. These are public static files: no API key,
JavaScript, login or MCP connection is needed to read them.

The post-build step resolves Markdown links against each original page's URL,
adds its canonical source address, and preserves code examples and tables. Page
titles must be unique so the plugin's combined output can be matched to the
rendered pages; missing or ambiguous entries fail the build. Tests cover both
host layouts and the artifact check follows every local link in every export.

At deployment, verify that the host serves these text files with a text content
type and without login, cookie consent or an interactive bot challenge. Check
ordinary unauthenticated HTTP requests in addition to browser navigation. Root
robots and security rules must permit the intended documentation fetches; a
training-crawler preference is separate from user-requested agent access.

## Production route

`wrangler.jsonc` deploys static files without an application Worker script.
The existing Cloudflare route for `typeroll.com/docs/*` selects this asset
service. A separate, narrowly scoped redirect rule canonicalizes `/docs` to
`/docs/` and preserves query strings. The apex is proxied while retaining its
original upstream address for other paths. The deployment token needs Workers
Scripts Write and Pages Write for the documentation account. Route and DNS
changes are separate operations; ordinary content releases do not alter them.

`verify-live-docs.mjs` checks the published source identity, every HTML and text
page, canonical URLs, agent indexes, real 404 responses and query preservation.
Pass `--redirects` after publishing the old-domain redirect artifact.
