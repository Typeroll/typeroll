---
title: Organization, Access and Workflow Tools
description: Manage API keys, site sharing, invites, workflows and new sites through MCP or the authenticated API, with the same permissions as the portal.
---

Organization administration in the portal is also available to agents and
scripts. Each MCP tool below wraps one authenticated API route and applies the
same permission check as the corresponding portal screen. A key never creates
a key or a share that reaches further than the key itself.

Two kinds of key are involved. A **site key** reaches one Site with admin
permission. An **organization key** acts for the Organization: admin on every
Site it owns, and the share's permission on Sites shared into it. Routes below
`/api/v1/organization/` and `/api/v1/publishing/` need an organization key; a
site key gets `403`.

## API keys

| Action                     | MCP tool                      | API route below `/api/v1`                | Permission             |
| -------------------------- | ----------------------------- | ---------------------------------------- | ---------------------- |
| List a Site's keys         | `list_api_keys`               | `GET /sites/{site}/api-keys`             | Any access to the Site |
| Create a site key          | `create_api_key`              | `POST /sites/{site}/api-keys`            | Admin on the Site      |
| Revoke a site key          | `revoke_api_key`              | `DELETE /sites/{site}/api-keys/{key_id}` | Admin on the Site      |
| List organization keys     | `list_organization_api_keys`  | `GET /organization/api-keys`             | Organization key       |
| Create an organization key | `create_organization_api_key` | `POST /organization/api-keys`            | Organization key       |
| Revoke an organization key | `revoke_organization_api_key` | `DELETE /organization/api-keys/{key_id}` | Organization key       |

Creating a key takes `{ "name": "CI deploys" }` (at most 80 characters) and
returns `201` with `key` metadata and `token`. As in **Settings → API keys**,
the token is shown exactly once and cannot be read again; store it where the
person asked for it. Lists return metadata only: id, name, creation, last use
and revocation. Keys created through the API record `created_by` as
`api-key:{prefix}` of the key that created them.

A site key can create and revoke keys for its own Site only, and never an
organization key. An organization key with admin permission on a shared-in Site
can create a site key for that Site; the new key belongs to the owning
Organization's Site and reaches nothing else. Revoking a key stops it
authenticating immediately, including the key making the call. Revoked keys
stay listed for audit.

## Share a Site with another Organization

| Action            | MCP tool            | API route below `/api/v1`                |
| ----------------- | ------------------- | ---------------------------------------- |
| List shares       | `list_site_shares`  | `GET /sites/{site}/shares`               |
| Share the Site    | `share_site`        | `POST /sites/{site}/shares`              |
| Change permission | `update_site_share` | `PATCH /sites/{site}/shares/{share_id}`  |
| Revoke a share    | `revoke_site_share` | `DELETE /sites/{site}/shares/{share_id}` |

All four need admin permission on the Site, as in the portal. `share_site`
takes `org_id` or `org_slug`, an optional `permission` (`read`, `write` — the
default — or `admin`) and an optional `label`. An Organization can hold one
active share per Site; change it with `update_site_share` instead of sharing
again (`409`). A Site cannot be shared with its own Organization. Revoking ends
access for the recipient and its keys immediately; the record stays listed with
`revoked_at`.

## Invite people to the Organization

`create_organization_invite` (`POST /api/v1/organization/invites`, body
`{ "ttl_days": 14 }`) returns a signed `invite_url` and its `expires_at`. The
lifetime is 1–30 days, 7 by default. The invited person opens the link, signs
in and joins as an **editor**, the same role as a portal invite. The link cannot be revoked before it expires, so send it only to the intended
person. Any member can invite in the portal; through the API this needs an
organization key.

**Self-hosting:** invites are signed with `FORMS_HMAC_SECRET` and use
`PORTAL_PUBLIC_URL` for the link. Without the secret the route returns `503`.

## Workflows

Server-side workflows run in the background on one Site. The same runs appear
under **Workflows** in the portal.

| Action                     | MCP tool           | API route below `/api/v1`                            | Permission        |
| -------------------------- | ------------------ | ---------------------------------------------------- | ----------------- |
| List types and recent runs | `list_workflows`   | `GET /sites/{site}/workflows`                        | Read              |
| Start a workflow           | `start_workflow`   | `POST /sites/{site}/workflows`                       | Write (see below) |
| Read status and results    | `get_workflow`     | `GET /sites/{site}/workflows/{workflow_id}`          | Read              |
| Approve a review gate      | `approve_workflow` | `POST /sites/{site}/workflows/{workflow_id}/approve` | Write             |

`start_workflow` takes `type` and an optional `config` with the same fields as
the portal form, and returns `workflow_id` with `202`:

| Type                                                            | Config                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `migration`                                                     | `wp_url`, optional `helper_api_key`                                   |
| `site_planning`                                                 | `business_description`                                                |
| `content_generation`                                            | `topic`, optional `tone` and `audience`                               |
| `content_improvement`                                           | optional `limit`                                                      |
| `url_parity`                                                    | optional `target_origin`, `source_origin`, `check_source`, `statuses` |
| `rebuild_deploy`                                                | `environment`: `staging` or `production`                              |
| `seo_audit`, `link_check`, `performance_audit`, `schema_markup` | none                                                                  |

`rebuild_deploy` publishes the Site and therefore needs admin permission, like
every other deploy route. `migration` needs the Organization's verified import
storage and returns `409 import_storage_required` until it is ready. Add
`?version={id}` (MCP: `version`) to run content workflows against a branch.

Poll `get_workflow` until `status` leaves `pending`/`running`. Migration, site
planning and URL parity stop at `paused_for_review` with `review_message` and
`review_data`. Show them to the person and approve only with their consent;
approving a run in any other status returns `409`. Status responses never
include internal step state, and credential fields such as `helper_api_key` are
masked.

## Create a Site with its first workflow

The portal's **New site** page offers three starts. All three are available
with an organization key:

| Start                   | MCP tool                  | API route below `/api/v1`        | Body                                        |
| ----------------------- | ------------------------- | -------------------------------- | ------------------------------------------- |
| Blank Site              | `create_site`             | `POST /sites`                    | `name`, optional `domain`                   |
| Migrate from WordPress  | `create_site_and_migrate` | `POST /sites/create-and-migrate` | `name`, `wp_url`, optional `helper_api_key` |
| Plan a new site with AI | `create_site_and_plan`    | `POST /sites/create-and-plan`    | `name`, `business_description`              |

The two workflow starts return `201` with `site` and `workflow`; follow the run
with `get_workflow` on the new Site. A migration start checks import storage
before anything is created.

## Publishing connections

GitHub and Cloudflare connection status, disconnecting, connecting Cloudflare
with a customer API token, and finishing media storage are described in
[Connect your accounts](../../guides/customer-publishing/#api-and-mcp).
OAuth sign-in and GitHub App installation remain browser steps:
`read_organization_publishing_connections` returns `connect_urls` for the person
who completes them.

## What stays in the portal

- **Creating an Organization.** An Organization is owned by a signed-in person,
  and an API key belongs to exactly one Organization, so a key cannot create or
  own another one.
- **Joining an Organization and switching between Organizations.** Both act on
  a person's sign-in session. Agents create the invite; the person redeems it.
- **OAuth sign-in** to GitHub and Cloudflare, which is bound to the person and
  browser that start it.
