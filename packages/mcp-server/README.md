# @typeroll/mcp-server

Model Context Protocol server for the [Typeroll](https://typeroll.com)
public API. Lets Claude (Desktop / claude.ai / Code) manage a Typeroll
site through the same tool surface a human agency would use: read and
write pages, partials, collections, media, redirects, versions; trigger
deploys; mint preview links.

The server is a **thin transport adapter** — every tool wraps one HTTP
endpoint of the Typeroll REST API. Auth happens at the API layer with a
site- or org-scoped key; the MCP just carries the bearer through.

## Two ways to connect

- **Hosted (Claude Desktop / claude.ai) — paste a URL.** No CLI, no
  Node.js install. In Claude open **Settings → Connectors → Add custom
  connector** and paste `https://app.typeroll.com/api/mcp`
  (or `https://<your-self-hosted-portal>/mcp`). Claude opens a consent
  page; paste your Typeroll API key there.
- **Stdio (Claude Code) — one `claude mcp add` command.** Best for local
  dev / agency staff already in a terminal. Instructions below.

This npm package is the stdio transport. The hosted endpoint ships as
part of the Typeroll portal itself — same tool surface, same package
under the hood.

## Key scopes

- **Org-scoped key** (created at `/app/settings/api-keys`) — one
  credential covers every site in your org *and* every site shared into
  your org. The default for the hosted Claude connector. Stdio works too
  if you set `TYPEROLL_SITE_ID` so the install binds to one site.
- **Site-scoped key** (created at `/app/sites/{siteId}/settings/api-keys`) —
  tighter blast radius for a single-site credential, e.g. one you'd
  hand to a customer for a self-managed site.

Both look like `typeroll_live_…`; revoke either from the portal and any
client using it stops working immediately.

## Stdio quick start (Claude Code)

1. **Create an API key** in your Typeroll portal — see the two scope
   options above. Org-scoped is the right default.

2. **Add the server to Claude Code.** Drop this into `~/.claude.json`
   (or your local `.claude/config.json`):

   ```json
   {
     "mcpServers": {
       "typeroll": {
         "command": "npx",
         "args": ["-y", "@typeroll/mcp-server"],
         "env": {
           "TYPEROLL_API_URL": "https://app.typeroll.com",
           "TYPEROLL_API_KEY": "typeroll_live_REPLACE_WITH_YOUR_KEY"
         }
       }
     }
   }
   ```

   For a self-hosted portal, point `TYPEROLL_API_URL` at it (e.g.
   `https://cms.example.com`).

   Prefer a scaffold? Run `npx @typeroll/mcp-server init` in your project
   folder — it writes/merges this `.mcp.json`, copies the skills into
   `.claude/skills/`, and adds an `AGENTS.md` pointer + imagegen-lab
   files. Idempotent; `--force` to overwrite. (Skills only:
   `npx @typeroll/mcp-server install-skills .claude/skills`.)

3. **Tell the agent what kind of work you want.** A good first message:

   > "Connect to Typeroll and tell me what you find — site name,
   > number of pages, what global blocks exist, what collections are
   > defined. Then I'll give you a task."

   Claude will call `get_site`, `get_site_capabilities`, `list_pages`,
   `list_partials`, `list_collections`, and `list_block_types` in sequence and
   report back. The capabilities + block palette are mandatory before it
   chooses HTML mode or reports a missing site-building feature.

## Environment variables (stdio)

| Var             | Required | Description |
|-----------------|----------|-------------|
| `TYPEROLL_API_URL`  | yes      | Base URL of your Typeroll portal. |
| `TYPEROLL_API_KEY`  | yes      | A `typeroll_live_…` bearer token. |
| `TYPEROLL_SITE_ID`  | sometimes | Pin to a specific site. Required when using an org-scoped key over stdio (the install can only target one site at a time); auto-detected for site-scoped keys. |

## Extension developer CLI

The package also installs `typeroll`. With an organization-scoped API key,
an external Extension repository can use the same developer and installation
APIs as the portal:

```sh
typeroll extension validate
typeroll extension push --draft
typeroll extension install --site test-site --config local-extension-config.json
typeroll extension promote 1.0.0
```

The manifest defaults to `typeroll-extension.json`; use `--manifest` to select
another file. Local validation is a fast preflight. The portal always performs
the complete schema, compatibility, origin and asset-hash validation.

## What the agent should read first

The package ships [AGENTS.md](./AGENTS.md), a self-contained briefing
that explains Typeroll conventions, common operations, and the safety
boundaries an agent needs to respect. Point Claude at it (or include it
in your project's `CLAUDE.md` / `AGENTS.md`) so it knows when to use
which tool.

## Tool surface

More than 100 tools across these families. See [AGENTS.md](./AGENTS.md) for
the full reference + concrete operation recipes.

- **Skills + guide (self-describing playbook)** — `read_guide`,
  `list_skills`, `read_skill`. The server advertises its own operating
  guide AND bundled recipes at runtime, so an agent gets the full context
  on connection without any files copied locally. `read_guide` returns the
  whole AGENTS.md briefing (data model, conventions, safety, tool families)
  — the bridge for the hosted connector, which can't read the file off
  disk. `list_skills` then surfaces the task recipes (`tr-new-site`,
  `tr-migrate-wp`, `tr-brand`, `tr-responsive`, …); `read_skill name=…`
  loads one. All pure local reads — no API key or site context — so they
  work identically on the hosted connector and over stdio.
- **Discovery** — `get_site`, `create_site` (bootstrap a new site — org-scoped
  key only), `update_site` (name/slug/domain), `list_versions`,
  `read_site_settings`, `update_site_settings`.
- **Pages** — list, read, batch-read, create, update (PATCH), replace
  (PUT), batch-update, delete, clone, get-preview, `set_page_mode`
  (flip between blocks/html), `convert_page_to_blocks`.
- **Blocks (instances)** — `get_page_blocks`, `add_block`,
  `update_block`, `move_block`, `remove_block`, `duplicate_block`,
  `set_block_responsive`. All take a `target` (page, partial, page
  template, or collection item-template), so one tool family edits
  every block container.
- **Global blocks (partials)** — list (summary mode by default), read,
  create free block, update, replace, delete, find-pages-using-block.
- **Block types** — list, read, create, update, delete,
  find-pages-using-block-type, plus `.tcblocks` export/import. Custom
  client-side JS (`script`) is honoured only when the site has enabled
  "Allow AI to write block scripts" (a human-set portal setting) —
  otherwise it's stripped with a warning.
- **Collections + items** — create/update/delete the collection schema
  itself (incl. `route_template` for per-item URLs); list/read/batch-
  read/create/update/delete items. Existing-collection tools consistently
  use `collection` (the old `name` argument remains accepted as an alias).
  Collection repeaters support `group_by`, and item templates can place
  `template/item_navigation` for deterministic previous/next links.
- **Media** — list, read, signed upload URLs, `upload_media_from_url`,
  `upload_media_batch_from_urls` (1–50 sources, max 25 MiB each, with
  partial-success results),
  `upload_media_inline` (all URL uploads auto-finalize after PUT — see below),
  patch metadata, delete, `finalize_media` (per-item: applies immutable
  Cache-Control + generates AVIF/WebP srcset variants — call after
  `create_upload_url`'s raw PUT path), `finalize_all_media` (bulk
  backfill for legacy libraries), `generate_image_variants` (the
  variant half of finalize, kept for surgical reruns),
  `suggest_alt_text_context` (returns a tuned prompt for your own
  vision model).
- **Rendering controls** — `core/table_of_contents`, per-site
  `trailing_slash`, exact `iframe_allowed_hosts`, `icon_192`, and per-page
  `append_seo_suffix=false`. The block editor supports labelled enums,
  line-based lists, nested repeating arrays and an internal-page URL picker.
- **Redirects** — list, create, delete. Plus automatic 301 on slug change.
- **Forms** — list, read, create, update, delete, list submissions.
  Place forms with `core/form` blocks or an HTML-mode `<x-form id="…" />`
  reference; preview/build expands both server-side to the same complete,
  signed form shell. Admins configure email and allowlisted, signed webhooks
  in the portal; action configuration stays off agent surfaces.
- **Extension installations** — list/read installed Extensions and update
  manifest-defined installation config through the API key with
  `update_extension_installation_config`; omitted and masked secrets are
  preserved. Use this for frontend config such as consent copy and policy
  links, then redeploy.
- **Settings** — read + patch, including `scripts_head` /
  `scripts_body_end` / `custom_css` (trusted because the caller holds an
  API key; the in-portal chat AI does NOT get these).
- **Core modules** — list the legacy `apps` registry, read schema + masked
  state, and enable, configure, or disable any module with the same admin API key used for content
  and deploys. Secret fields are encrypted server-side and never returned;
  Analytics provisioning runs on the platform. Deploy after updates whose
  response has `affects_build: true`.
- **Search + link integrity** — `search_pages` plus `check_internal_links`,
  which resolves saved database content against pages, collection/facet routes,
  media and redirect chains without crawling the public site.
- **Bulk** — `bulk_replace_text` with dry-run across pages, partials,
  block data and schema-defined collection-item fields.
- **Migration inventory** — bulk add/update decisions, recursive
  `import_sitemap`, direct or CSV-fallback `import_gsc_performance`, and compact
  `verify_migration_urls` (successful rows omitted unless requested).
- **Branches** — create, read, delete, merge. Branch deploys get their
  own URL at `{branch}.{project}.pages.dev`.
- **Deploy** — trigger (with `dry_run` to build without publishing), list, get
  status. A finished job reports `cost`: what the build consumed in server
  time, broken down per phase. Estimates from a rate card, not billing records.
- **Preview** — `get_preview_link` (signed URL for browser navigation;
  supports `page_id`, `slug`, or `collection_name + item_id`; pass
  `include_working_copy: true` to also render unsaved drafts).
- **Drafts (the buffer model)** — every content write lands in a per-doc
  unsaved draft (working copy); deploys and plain previews see saved
  content only. Save explicitly with `commit_working_copy` or `save: true`
  on the write call; inspect/discard with `read_working_copy` /
  `discard_working_copy`. Status changes and structural operations apply
  immediately.

## Direct REST API access

If you don't want the MCP wrapper, the same surface is reachable directly
with curl:

```bash
curl -H "Authorization: Bearer typeroll_live_..." \
  https://app.typeroll.com/api/v1/sites/<siteId>/pages
```

The MCP server is purely an ergonomics layer on top of that. The complete v1
contract, including payload envelopes and collection-item slug addressing, is
documented in [`docs/v1-api.md`](../../docs/v1-api.md).

## Security model

- API keys are **site-scoped or org-scoped** (see "Key scopes" above) —
  enforced server-side. A site-scoped key cannot touch any other site;
  an org-scoped key reaches the org's own sites plus sites explicitly
  shared into the org, with the share's permission level applied.
- All write calls (`POST`, `PUT`, `PATCH`, `DELETE`) are **audit-logged**
  with the key prefix, IP, method, path, and status. Reads are not
  logged (cost vs. value).
- **Rate limits**: 600 reads/min, 60 writes/min per key. 429 responses
  carry `Retry-After` headers.
- **HTML sanitization** happens at save time on the server — `<script>`,
  event handlers, and `javascript:` URLs are stripped from page/partial
  content (including `core/html` block output). The scriptable surfaces
  are deliberate exceptions, and all of them are writable with an API key
  under the key holder's own authority: `scripts_*` and `custom_css` on
  the site settings, `script` on a block type, and the `js` field of a
  `core/embed` block instance. Those writes are audit-logged and the
  response carries a notice naming the stored JS. Only the in-portal chat
  assistant is additionally gated, on a per-site opt-in.
- Keys can be **revoked** at any time from the portal. Revocation takes
  effect on the next request (no in-flight requests get cancelled, but
  the next one returns 401).

## More

- Full end-to-end production setup recipe with troubleshooting:
  [docs/claude-code-mcp-setup.md](../../docs/claude-code-mcp-setup.md)
- Agent operations briefing: [AGENTS.md](./AGENTS.md)
- Boilerplate skills (site building, brand, forms, SEO, blog,
  collections, migration, image generation, redesign, …):
  [skills/](./skills/)

## License

MIT — see [LICENSE](../../LICENSE).
