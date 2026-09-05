# Typeroll v1 REST API

The public REST API is the canonical transport used by the Typeroll MCP
server. Routes are rooted at:

```text
https://app.typeroll.com/api/v1
```

## Authentication, versions, and errors

Send `Authorization: Bearer typeroll_live_…` on every request. A site-scoped
key can reach only its site. An organization-scoped key can reach owned sites
and explicitly shared sites, subject to the share permission.

Versioned resources accept `?version=<version-id>` and default to `main`.
Migration inventory records and media are site-wide. Reads are limited to 600
requests/minute and writes to 60 requests/minute per key. A `429` response has
both a `Retry-After` header and a structured retry delay in its JSON error.

Errors use:

```json
{ "error": "Human-readable explanation" }
```

Successful resource responses retain their established top-level keys.
Collection list/get/create/update operations additionally expose the same
payload under `data`; clients should prefer `data` for new integrations while
older clients can continue reading `collection`, `collections`, `item`, or
`items` at the top level.

## Writable payload conventions

- Page and partial PATCH routes accept writable fields at the top level.
- Collection schema PATCH accepts either top-level fields or the MCP-shaped
  `{ "patch": { … } }` form.
- Collection item PATCH accepts `{ "fields": { … } }` and the equivalent
  `{ "patch": { … } }`. `status` and `save` remain top-level controls.
- Content fields are staged in a working copy. Pass `save: true` to commit in
  the same call, or commit the working copy separately.
- Unknown writable fields are rejected or dropped according to the resource's
  schema contract. A `409` names collection fields rejected by field authority.

Collection-item `{itemId}` parameters resolve an internal document id first,
then the collection's configured `slug_field`. Responses include
`resolved_by: "id" | "slug"`.

## Route index

All site routes below start with `/sites/{siteId}`.

| Resource | Routes |
|---|---|
| Sites | `GET /sites`, `POST /sites`, `GET/PATCH /sites/{siteId}`, `GET /sites/{siteId}/capabilities` |
| Settings | `GET/PATCH /settings` |
| Pages | `GET/POST /pages`, `GET/PATCH/PUT/DELETE /pages/{pageId}`, `POST /pages/batch-read`, `PATCH /pages/batch`, clone, mode conversion, preview and block-container routes |
| Partials | `GET/POST /partials`, `GET/PATCH/PUT/DELETE /partials/{partialId}`, usage and block-container routes |
| Page templates | list/create/read/update/delete plus block-container routes under `/templates` |
| Block types | list/create/read/update/delete, usage, import and export under `/block-types` |
| Collections | `GET/POST /collections`, `GET/PATCH/DELETE /collections/{name}` |
| Collection items | `GET/POST /collections/{name}/items`, `POST …/batch-read`, `GET/PATCH/DELETE …/items/{itemId-or-slug}` |
| Collection analysis | completeness and listing regeneration under `/collections/{name}` |
| Working copies | `GET/PATCH/DELETE /working-copy/{page|partial|item}/…`, plus commit |
| Media | list/create/read/update/delete, upload URL, finalize, bulk finalize, variant generation and alt-text context under `/media` |
| Redirects | `GET/POST /redirects`, `DELETE /redirects/{redirectId}` |
| Forms | list/create/read/update/delete and submission routes under `/forms` |
| Apps and Extensions | list/read/update app config; list/read/update Extension installation config |
| Versions | list/create/read/delete/merge under `/versions` |
| Deploys | list/create/read under `/deploys`; deploy jobs include non-blocking `warnings[]` such as unresolved internal links |
| Preview | signed preview-link creation under `/preview-link` |
| Search and bulk | `GET /search`, `POST /bulk-replace`, `GET /internal-links` |
| Migration | preflight, URL inventory routes, imports and deployed parity verification described below |
| Insights and attribution | site insights and funnel-attribution read/update routes |

The API route source under `packages/portal/src/pages/api/v1` is exhaustive;
the index above groups specialized subroutes rather than hiding them behind a
second undocumented RPC surface.

## Extension installation configuration

Use an admin-capable API key to inspect or update an installed Extension:

```http
GET /sites/{siteId}/extensions/{installationId}
PATCH /sites/{siteId}/extensions/{installationId}
Content-Type: application/json

{
  "config": {
    "policy_link_text": "Privacy policy",
    "policy_url": "/privacy/"
  }
}
```

The PATCH route accepts manifest-declared `config` keys and can also update
`version`, `granted_scopes`, or `status` (`enabled` or `disabled`). Config is
merged: omitted fields preserve their current values, including secret fields.
Reads and responses expose only masked config and never return encrypted or
private secret material.

Extension public config and provisioned component definitions are compiled
into the static site. A successful update therefore returns
`affects_build: true` and `redeploy_required: true`. Queue the deploy with
`POST /sites/{siteId}/deploy`. The `typeroll extension configure` CLI command
and `update_extension_installation_config` MCP tool perform that production
deploy step by default; both provide an explicit opt-out for batching.

## Migration inventory

### Bulk decisions

```http
PATCH /sites/{siteId}/migration-urls
```

Select exactly one of up to 2,000 ids or a source-wide filter:

```json
{
  "where": { "source": "wordpress-redirect-guess" },
  "patch": {
    "excluded": true,
    "notes": "Reviewed as CMS-invented paths"
  }
}
```

The response reports `matched`, `updated`, `unchanged`, `not_found`, and the
current coverage `summary`.

### Sitemap import

```http
POST /sites/{siteId}/migration-urls/import-sitemap
```

```json
{
  "url": "https://old.example.com/sitemap_index.xml",
  "source_origin": "https://old.example.com"
}
```

Sitemap indexes are followed recursively, cycles and duplicates are collapsed,
foreign-origin page URLs are rejected, and parse/fetch exceptions are returned
in `sitemap_errors`. Slash-equivalent paths share one normalized inventory
entry, while its `observed_paths` retains every spelling found at the source.

### Search Console import

```http
POST /sites/{siteId}/migration-urls/import-gsc
```

Direct query:

```json
{ "property": "https://old.example.com/", "months": 6 }
```

CSV fallback:

```json
{
  "csv": "Page,Clicks,Impressions\nhttps://old.example.com/a,12,40",
  "source_origin": "https://old.example.com"
}
```

The direct path uses Google Application Default Credentials or the JSON value
in `GOOGLE_SEARCH_CONSOLE_CREDENTIALS`; grant that service identity read access
to the Search Console property. Imports query the `page` dimension, strip URL
fragments, aggregate clicks/impressions, merge existing inventory entries, and
insert previously unknown URLs. `unhandled_urls` makes new sitemap gaps
explicit.

### Compact deployed verification

```http
POST /sites/{siteId}/migration-urls/verify
```

The default response contains the complete summary and only `missing`,
`broken_redirect`, and `error` rows. Set `include_successes: true`, or pass an
exact `verdicts` array. The site's trailing-slash policy is applied before a
canonical slash redirect is classified. Verification requests every distinct
`observed_paths` value, so `summary.checked` counts source URL variants and can
be larger than the normalized inventory count.

Static deploys expand each redirect to cover both slash spellings of its source
path, except `/` and file/resource paths. Internal destinations are normalized
to the site's `always`, `never`, or `ignore` policy without dropping query
parameters. Explicit rules for both source spellings retain their individual
destinations. Existing sites receive this behavior on their next build; stored
redirect documents do not require migration.

## Database internal-link check

```http
GET /sites/{siteId}/internal-links?version=main
```

This performs no public crawl. It finds hrefs in the content that is eligible
for the selected build, then resolves them against page paths, collection item
routes, facet routes, same-origin media paths, and exact/pattern redirect
chains. Broken rows include `from`, `href`, `resolved_path`, and `reason`.
Deploys run the same check as a non-blocking preflight and retain findings in
the deploy job's `warnings` array.

## Bulk text replacement

```http
POST /sites/{siteId}/bulk-replace
```

```json
{
  "pattern": "Old name",
  "replacement": "New name",
  "scope": "all",
  "dry_run": true
}
```

`scope` is `pages` (default), `partials`, `collection_items`, or `all`.
Restrict with `page_ids`, `partial_ids`, or `collection` plus `item_ids`.
Block resources modify editorial `data` only; stable ids and types never
change. Collection changes are schema-limited and field-authority conflicts
are returned in `conflicts`. Review `sample_diffs`, then repeat with
`dry_run: false` and optionally `save: true`.
