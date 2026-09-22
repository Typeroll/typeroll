---
title: MCP Tool Reference
description: The site-management tools the Typeroll MCP server exposes to AI agents — grouped by category.
---

The Typeroll MCP server gives the AI agent a complete toolkit for managing sites. Your agent selects tools based on your instructions. You can also build your own integration with the authenticated API.

## Tool categories

| Category                                         | Tools                                                                                                                                                                                                                                                                                                    | What they do                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Pages](../pages/)                               | `create_page`, `read_page`, `update_page`, `list_pages`, `batch_update_pages`, `batch_read_pages`, `search_pages`, `delete_page`, `set_page_mode`, `convert_page_to_blocks`                                                                                                                              | Create and edit pages (HTML- or block-mode)                                                                    |
| [Blocks](../blocks/)                             | `get_page_blocks`, `add_block`, `update_block`, `move_block`, `remove_block`, `duplicate_block`, `set_block_responsive`, `list_block_types`, `read_block_type`, `create_block_type`, `update_block_type`, `delete_block_type`, `find_pages_using_block_type`, `export_block_types`, `import_block_types` | Compose pages/partials/templates from ~40 reusable blocks; author custom block types                           |
| [Partials](../partials/)                         | `read_partial`, `replace_partial`, `list_partials`                                                                                                                                                                                                                                                       | Header, footer and shared HTML fragments (HTML- or block-mode)                                                 |
| [Settings](../settings/)                         | `read_site_settings`, `update_site_settings`, `get_site`, `list_sites`                                                                                                                                                                                                                                   | Site-wide config: colours, fonts, domain                                                                       |
| [Content types and templates](../content-types/) | `create_content_type`, `read_content_type`, `list_content_types`, `update_content_type`, `change_page_content_type`, `create_page_template`, `page_completeness`                                                                                                                                         | Field schemas and reusable layouts for Pages.                                                                  |
| [Page templates](../blocks/#block-containers)    | `list_page_templates`, `set_page_template`                                                                                                                                                                                                                                                               | Assign a PageTemplate to a page; edit templates via the block tools with `target: { kind: 'template', id }`    |
| [Forms](../forms/)                               | `create_form`, `read_form`, `update_form`, `list_forms`, `delete_form`                                                                                                                                                                                                                                   | Contact and booking forms                                                                                      |
| [Media](../media/)                               | `upload_media_from_url`, `upload_media_from_base64`, `list_media`                                                                                                                                                                                                                                        | Images and other media assets                                                                                  |
| [Redirects](../redirects/)                       | `create_redirect`, `list_redirects`, `delete_redirect`                                                                                                                                                                                                                                                   | URL redirects                                                                                                  |
| [Migration URLs](../migration-urls/)             | `list_migration_urls`, `add_migration_urls`, `update_migration_url`, `delete_migration_url`, `repair_migration_plain_text`, `verify_migration_urls`                                                                                                                                                      | Track every URL the old site had, repair legacy WordPress text, and prove the new one answers before DNS moves |
| [Deploy](../deploy/)                             | `trigger_deploy`, `get_deploy_status`, `get_preview_link`                                                                                                                                                                                                                                                | Build and deploy the site                                                                                      |

## How tools are selected

The AI agent picks tools based on context. You never need to say "call `create_page`" — just describe what you want:

> "Add a Services page with three service cards" → the AI agent calls `create_page`

> "Update the nav to include the new Services link" → the AI agent calls `read_partial`, then `replace_partial`

> "Deploy it" → the AI agent calls `trigger_deploy`, then polls `get_deploy_status`

## Authentication

All tool calls go through the MCP server, which forwards your `TYPEROLL_API_KEY` to the portal API. Organization and site keys have different scopes; each call is limited to the sites and operations the key permits.

## Calling the same operations over REST

Every tool above is a thin wrapper over the authenticated REST API, and the API
is the same key and the same permissions. If you are scripting rather than
driving an agent, the tool name is not what you call — the route is. The
correspondence is by resource, not by tool name:

| Resource       | Route family                            |
| -------------- | --------------------------------------- |
| Pages          | `/api/v1/sites/{siteId}/pages`          |
| Partials       | `/api/v1/sites/{siteId}/partials`       |
| Settings       | `/api/v1/sites/{siteId}/settings`       |
| Forms          | `/api/v1/sites/{siteId}/forms`          |
| Redirects      | `/api/v1/sites/{siteId}/redirects`      |
| Migration URLs | `/api/v1/sites/{siteId}/migration-urls` |
| Content types  | `/api/v1/sites/{siteId}/content-types`  |
| Media          | `/api/v1/sites/{siteId}/media`          |
| Deploys        | `/api/v1/sites/{siteId}/deploy`         |

Three things that do not follow the pattern, because each has cost someone an
afternoon:

- **Bulk page operations are their own routes**, not a flag on `/pages`:
  `POST /api/v1/sites/{siteId}/pages/batch-read` takes `{ page_ids }` and
  `POST /api/v1/sites/{siteId}/pages/batch-write` takes
  `[{ page_id, patch, save? }]`, both up to 200 entries with per-entry results.
  Reach for these before writing a loop over single-page calls — a loop across a
  whole site is slower, reports nothing per entry, and leaves a partial result
  you have to reconstruct by reading the data back.

- **An installed app's admin actions run through Core**, not against the app
  directly: `POST /api/v1/sites/{siteId}/extensions/{installationId}/admin-request`
  with `{ page_id, path, method, query?, body? }`. An ordinary
  site-administrator API key is sufficient — Core mints the app's administrator
  proof on its behalf and records the actor as `api-key:{prefix}`. You do not
  need a portal session, and the app's own guide lists the paths it accepts.

- **Reads return accepted content.** A page with an uncommitted working copy
  comes back as it was last saved, not as it currently reads in the editor. Use
  `read_page` or the single-page route when you need to tell a draft from
  accepted content; the list and batch-read routes will not show you the
  difference.

## Rate limits

The portal API is rate-limited per API key. For large batch operations (importing many pages, bulk SEO updates), the AI agent uses `batch_update_pages` to stay within limits.
