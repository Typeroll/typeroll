# Typeroll CMS documentation

This package owns the public Starlight documentation at
**https://typeroll.com/docs/**. Use **Typeroll CMS** as the product name, describe
AI agents generically, and keep client-specific setup instructions scoped to
the client that actually needs them. The former documentation hostname has
been retired; do not restore its DNS, domain binding or redirect deployment.

## Build and verify

From the repository root:

```sh
npm run build:docs
npm run prepare:migration --workspace=@typeroll/docs-site
```

Every build targets `https://typeroll.com/docs/` and writes the ignored
`temp/docs-subdirectory/` directory. The `build:subdirectory` command remains
an alias. Selecting the former subdomain target is rejected.

The legacy-named `prepare:migration` command now prepares only
`temp/docs-migration/main-host/docs/`, an exact source identifier, `routes.json`
and additions for the main host's root robots/llms files. It does not deploy.
There is no old-domain redirect artifact. Never replace the main website with
this overlay or publish the whole preparation directory.

Every build checks titles, H1s, canonical URLs, indexing, sitemap membership,
source edit links, JSON-LD, internal links, images and agent-readable exports.
The release workflow publishes the static assets and verifies the exact live
source. It does not publish to the retired Pages project.

Content links should be relative to their public page URL. Use HTML `img`
elements for relative public image URLs; Markdown relative images are resolved
against the source file by Astro.

## Public access and routing

`wrangler.jsonc` deploys static files without an application Worker script.
The Cloudflare route `typeroll.com/docs/*` selects this asset service. Separate
rules normalize `/docs` to `/docs/`, HTTP docs URLs to HTTPS, and `www` to the
apex while preserving query strings. The proxied apex otherwise serves the
main website, which is managed independently in Typeroll Cloud.

The deployment token needs Workers Scripts Write for the docs account.
DNS and route changes are separate operations. Ordinary releases do not change
them. Missing docs paths must return the docs 404 page with HTTP 404.

`verify-live-docs.mjs --source-sha <commit>` checks every live HTML and text page,
source identity, canonical URLs, agent indexes, real 404 responses, robots,
sitemaps, JSON-LD and query preservation. Root robots.txt must advertise the
docs sitemap; `/docs/robots.txt` alone cannot govern the host's crawling policy.
Search Console ownership and indexing reports require separate verification.

## Documentation for AI agents

All pages have an `index.txt` alternative. `llms.txt` indexes them;
`llms-full.txt` and `llms-small.txt` provide complete and shorter Markdown sets.
HTML advertises the text alternatives. Exports preserve code, tables and
absolute links and identify the canonical source. They require no login,
JavaScript, cookie consent or interactive challenge.

CMS/API/MCP operations still require authentication. Named client end-to-end
connection checks are separate from successfully fetching public documentation.

## Screenshots

Editor screenshots use synthetic content in the real editor at 1440×900 and
390×844. Refresh them when documented controls change; never publish customer
content, authenticated exports or secrets.
