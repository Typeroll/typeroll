---
title: MCP Tool Reference
description: The site-management tools the Typeroll MCP server exposes to AI agents — grouped by category.
---

The Typeroll MCP server gives the AI agent a complete toolkit for managing sites. Your agent selects tools based on your instructions. You can also build your own integration with the authenticated API.

## Tool categories

| Category                                                                                  | Tools                                                                                                                                                                                                                                                                                                                                                                                        | What they do                                                                                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Pages](../pages/)                                                                        | `create_page`, `read_page`, `update_page`, `list_pages`, `batch_update_pages`, `batch_read_pages`, `search_pages`, `delete_page`, `set_page_mode`                                                                                                                                                                                                                                            | Create and edit pages (HTML- or block-mode)                                                                            |
| [Blocks](../blocks/)                                                                      | `get_page_blocks`, `add_block`, `update_block`, `move_block`, `remove_block`, `duplicate_block`, `set_block_responsive`, `list_block_types`, `read_block_type`, `create_block_type`, `update_block_type`, `delete_block_type`, `find_pages_using_block_type`, `export_block_types`, `import_block_types`                                                                                     | Compose pages/partials/templates from ~40 reusable blocks; author custom block types                                   |
| [Partials](../partials/)                                                                  | `read_partial`, `replace_partial`, `list_partials`, `make_block_global`, `detach_global_block`, `list_block_templates`, `save_block_template`, `insert_block_template`                                                                                                                                                                                                                       | Header, footer and shared HTML fragments (HTML- or block-mode)                                                         |
| [Settings](../settings/)                                                                  | `read_site_settings`, `update_site_settings`, `get_site`, `list_sites`, `update_site`, `archive_site`, `restore_site`                                                                                                                                                                                                                                                                        | Site-wide config, the AI block-scripts toggle, and archiving or restoring a site                                       |
| [Content types and templates](../content-types/)                                          | `create_content_type`, `read_content_type`, `list_content_types`, `update_content_type`, `change_page_content_type`, `create_page_template`, `page_completeness`                                                                                                                                                                                                                             | Field schemas and reusable layouts for Pages.                                                                          |
| [Page templates](../blocks/#block-containers)                                             | `list_page_templates`, `set_page_template`                                                                                                                                                                                                                                                                                                                                                   | Assign a PageTemplate to a page; edit templates via the block tools with `target: { kind: 'template', id }`            |
| [Forms](../forms/)                                                                        | `create_form`, `read_form`, `update_form`, `list_forms`, `delete_form`, `get_form_capabilities`, `list_form_submissions`, `read_form_submission`, `delete_form_submission`                                                                                                                                                                                                                   | Contact and booking forms, their email and webhook actions (admin), and submissions                                    |
| [Email](../email/)                                                                        | `get_email_settings`, `set_email_settings`, `delete_email_settings`, `send_test_email`, `get_incoming_email_settings`, `set_incoming_email_forwarding`, `read_incoming_email_receipt`                                                                                                                                                                                                        | The email provider form notifications send through, and incoming email forwarding (admin)                              |
| [Media](../media/)                                                                        | `upload_media_from_url`, `upload_media_from_base64`, `list_media`, `get_media_upload_status`, `purge_site_media`                                                                                                                                                                                                                                                                             | Images and other media assets                                                                                          |
| [Redirects](../redirects/)                                                                | `create_redirect`, `list_redirects`, `delete_redirect`                                                                                                                                                                                                                                                                                                                                       | URL redirects                                                                                                          |
| [Migration URLs](../migration-urls/)                                                      | `list_migration_urls`, `add_migration_urls`, `update_migration_url`, `delete_migration_url`, `repair_migration_plain_text`, `verify_migration_urls`                                                                                                                                                                                                                                          | Track every URL the old site had, repair legacy WordPress text, and prove the new one answers before DNS moves         |
| [Deploy](../deploy/)                                                                      | `trigger_deploy`, `get_deploy_status`, `get_preview_link`                                                                                                                                                                                                                                                                                                                                    | Build and deploy the site                                                                                              |
| [Versions and branches](../versions/)                                                     | `list_versions`, `create_branch`, `read_version`, `diff_version`, `merge_branch`, `reset_version`, `delete_branch`                                                                                                                                                                                                                                                                           | Work on a branch, review its changes, merge, reset or delete it                                                        |
| [History](../drafts-and-saving/#history-and-restore)                                      | `list_page_revisions`, `read_page_revision`, `preview_page_revision`, `restore_page_revision`, `list_partial_revisions`, `read_partial_revision`, `restore_partial_revision`                                                                                                                                                                                                                 | Inspect, render and restore earlier saved states of pages, headers, footers and global blocks                          |
| [Extensions](../../extensions/getting-started/#manage-installations-from-the-api-and-mcp) | `list_extension_installations`, `read_extension_installation`, `install_extension`, `update_extension_installation_config`, `activate_extension_release`, `set_extension_installation_status`, `uninstall_extension`, `read_extension_diagnostics`, `pair_extension_issuer`, `launch_extension_admin_page`, `call_extension_admin`, plus developer tools such as `publish_extension_version` | Install and administer Extensions on a site, and publish your own                                                      |
| [Organization, access and workflows](../organization/)                                    | `list_api_keys`, `revoke_api_key`, `list_organization_api_keys`, `revoke_organization_api_key`, `list_site_shares`, `share_site`, `update_site_share`, `revoke_site_share`, `create_organization_invite`, `list_workflows`, `start_workflow`, `get_workflow`, `approve_workflow`, `create_site_and_migrate`, `create_site_and_plan`                                                          | API keys, sharing a Site with another Organization, invites, server-side workflows and new Sites with a first workflow |
| [Publishing connections](../../guides/customer-publishing/#api-and-mcp)                   | `read_organization_publishing_connections`, `diagnose_organization_github_connection`, `disconnect_organization_publishing_provider`, `connect_organization_cloudflare`, `prepare_organization_media_storage`, `save_organization_media_access`                                                                                                                                              | Organization GitHub and Cloudflare connections and media storage                                                       |

## How tools are selected

The AI agent picks tools based on context. You never need to say "call `create_page`" — just describe what you want:

> "Add a Services page with three service cards" → the AI agent calls `create_page`

> "Update the nav to include the new Services link" → the AI agent calls `read_partial`, then `replace_partial`

> "Deploy it" → the AI agent calls `trigger_deploy`, then polls `get_deploy_status`

## Authentication

All tool calls go through the MCP server, which forwards your `TYPEROLL_API_KEY` to the portal API. Organization and site keys have different scopes; each call is limited to the sites and operations the key permits. Tools that manage keys, sharing and workflows apply the same permission checks as the portal, and a key never creates a key or share that reaches further than itself; see [Organization, access and workflow tools](../organization/).

## Calling the same operations over REST

Every tool above is a thin wrapper over the authenticated REST API, and the API
is the same key and the same permissions. Those permissions are the portal's:
what a person with a given role can do in the portal, a key with the same
permission can do through the API and MCP, and an action that needs admin in the
portal (settings, publishing, domains, apps, archiving) needs it here too. If you are scripting rather than
driving an agent, the tool name is not what you call — the route is. The
correspondence is by resource, not by tool name:

| Resource                      | Route family                                                    |
| ----------------------------- | --------------------------------------------------------------- |
| Pages                         | `/api/v1/sites/{siteId}/pages`                                  |
| Partials                      | `/api/v1/sites/{siteId}/partials`                               |
| Site                          | `/api/v1/sites/{siteId}`                                        |
| Settings                      | `/api/v1/sites/{siteId}/settings`                               |
| Lifecycle                     | `/api/v1/sites/{siteId}/lifecycle`                              |
| Forms                         | `/api/v1/sites/{siteId}/forms`                                  |
| Form capabilities             | `/api/v1/sites/{siteId}/form-capabilities`                      |
| Email provider                | `/api/v1/sites/{siteId}/integrations/email`                     |
| Incoming email                | `/api/v1/sites/{siteId}/delivery/inbound`                       |
| Redirects                     | `/api/v1/sites/{siteId}/redirects`                              |
| Migration URLs                | `/api/v1/sites/{siteId}/migration-urls`                         |
| Content types                 | `/api/v1/sites/{siteId}/content-types`                          |
| Media                         | `/api/v1/sites/{siteId}/media`                                  |
| Deploys                       | `/api/v1/sites/{siteId}/deploy`                                 |
| Versions                      | `/api/v1/sites/{siteId}/versions`                               |
| Extensions                    | `/api/v1/sites/{siteId}/extensions`                             |
| Site API keys                 | `/api/v1/sites/{siteId}/api-keys`                               |
| Site sharing                  | `/api/v1/sites/{siteId}/shares`                                 |
| Workflows                     | `/api/v1/sites/{siteId}/workflows`                              |
| Organization keys and invites | `/api/v1/organization/api-keys`, `/api/v1/organization/invites` |
| Publishing connections        | `/api/v1/publishing/connections`                                |

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
