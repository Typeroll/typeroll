---
title: MCP Tool Reference
description: All 90+ tools the Typeroll MCP server exposes to Claude — grouped by category.
---

The Typeroll MCP server gives Claude a complete toolkit for managing sites. You never call these tools yourself — Claude decides which ones to use based on your instructions.

## Tool categories

| Category                                          | Tools                                                                                                                                                                                                                                                                                                    | What they do                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Pages](/tools/pages/)                            | `create_page`, `read_page`, `update_page`, `list_pages`, `batch_update_pages`, `batch_read_pages`, `search_pages`, `delete_page`, `set_page_mode`, `convert_page_to_blocks`                                                                                                                              | Create and edit pages (HTML- or block-mode)                                                                      |
| [Blocks](/tools/blocks/)                          | `get_page_blocks`, `add_block`, `update_block`, `move_block`, `remove_block`, `duplicate_block`, `set_block_responsive`, `list_block_types`, `read_block_type`, `create_block_type`, `update_block_type`, `delete_block_type`, `find_pages_using_block_type`, `export_block_types`, `import_block_types` | Compose pages/partials/templates from ~40 reusable blocks; author custom block types                             |
| [Partials](/tools/partials/)                      | `read_partial`, `replace_partial`, `list_partials`                                                                                                                                                                                                                                                       | Header, footer and shared HTML fragments (HTML- or block-mode)                                                   |
| [Settings](/tools/settings/)                      | `read_site_settings`, `update_site_settings`, `get_site`, `list_sites`                                                                                                                                                                                                                                   | Site-wide config: colours, fonts, domain                                                                         |
| [Collections](/tools/collections/)                | `create_collection`, `read_collection`, `list_collections`, `create_collection_item`, `read_collection_item`, `update_collection_item`, `list_collection_items`, `delete_collection_item`                                                                                                                | Structured content: blog posts, team members, products. Item layouts can be block trees (`item_template_blocks`) |
| [Page templates](/tools/blocks/#block-containers) | `list_page_templates`, `set_page_template`                                                                                                                                                                                                                                                               | Assign a PageTemplate to a page; edit templates via the block tools with `target: { kind: 'template', id }`      |
| [Forms](/tools/forms/)                            | `create_form`, `read_form`, `update_form`, `list_forms`, `delete_form`                                                                                                                                                                                                                                   | Contact and booking forms                                                                                        |
| [Media](/tools/media/)                            | `upload_media_from_url`, `upload_media_from_base64`, `list_media`                                                                                                                                                                                                                                        | Images and other media assets                                                                                    |
| [Redirects](/tools/redirects/)                    | `create_redirect`, `list_redirects`, `delete_redirect`                                                                                                                                                                                                                                                   | URL redirects                                                                                                    |
| [Migration URLs](/tools/migration-urls/)          | `list_migration_urls`, `add_migration_urls`, `update_migration_url`, `delete_migration_url`, `verify_migration_urls`                                                                                                                                                                                     | Track every URL the old site had; prove the new one answers before DNS moves                                     |
| [Deploy](/tools/deploy/)                          | `trigger_deploy`, `get_deploy_status`, `get_preview_link`                                                                                                                                                                                                                                                | Build and deploy the site                                                                                        |

## How tools are selected

Claude picks tools based on context. You never need to say "call `create_page`" — just describe what you want:

> "Add a Services page with three service cards" → Claude calls `create_page`

> "Update the nav to include the new Services link" → Claude calls `read_partial`, then `replace_partial`

> "Deploy it" → Claude calls `trigger_deploy`, then polls `get_deploy_status`

## Authentication

All tool calls go through the MCP server, which forwards your `TYPEROLL_API_KEY` to the portal API. The key is scoped to your organisation — Claude can only access sites that belong to your account.

## Rate limits

The portal API is rate-limited per API key. For large batch operations (importing many pages, bulk SEO updates), Claude uses `batch_update_pages` to stay within limits.
