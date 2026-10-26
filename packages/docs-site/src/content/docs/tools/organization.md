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

| Action                     | MCP tool                      | API route below `/api/v1`                | Permission        |
| -------------------------- | ----------------------------- | ---------------------------------------- | ----------------- |
| List a Site's keys         | `list_api_keys`               | `GET /sites/{site}/api-keys`             | Admin on the Site |
| Revoke a site key          | `revoke_api_key`              | `DELETE /sites/{site}/api-keys/{key_id}` | Admin on the Site |
| List organization keys     | `list_organization_api_keys`  | `GET /organization/api-keys`             | Organization key  |
| Revoke an organization key | `revoke_organization_api_key` | `DELETE /organization/api-keys/{key_id}` | Organization key  |

New API keys are created only in the portal (**Site settings → API keys** or
**Organization settings → API keys**), where the token is shown once to the
person creating it. Organization keys are created, listed and revoked in the
portal by organization owners and admins only, also in Organizations that do not
enforce member roles. The API and MCP do not create keys, so a secret never lands
in an agent's conversation, a tool log or a chat history; `POST` to these routes
returns `403` saying where to create one. Lists return metadata only: id, name,
creator, creation, last use and revocation, and need admin permission on the
Site because they name people and addresses. The last-use address is the one
the deployment's trusted proxy appended (`AUTH_TRUST_PROXY_HOPS`, see
[self-hosting](../../guides/self-hosting/)); a client-supplied
`X-Forwarded-For` value is not stored.

Site keys are created only by the Organization that owns the Site. An
administrator of an Organization the Site is shared with can list and revoke
its keys through the API and MCP but not create one: a site key is stored
with the Site, not with the share, and would otherwise outlive it. Use an organization key to reach shared
Sites. Site keys a recipient created before this rule are revoked when its
share is revoked or lowered below admin, and cannot archive, restore or purge
the Site.

A site key can revoke keys for its own Site only. Revoking a key stops it
authenticating immediately, including the key making the call. Revoked keys
stay listed for audit.

## Share a Site with another Organization

| Action            | MCP tool            | API route below `/api/v1`                |
| ----------------- | ------------------- | ---------------------------------------- |
| List shares       | `list_site_shares`  | `GET /sites/{site}/shares`               |
| Share the Site    | `share_site`        | `POST /sites/{site}/shares`              |
| Change permission | `update_site_share` | `PATCH /sites/{site}/shares/{share_id}`  |
| Revoke a share    | `revoke_site_share` | `DELETE /sites/{site}/shares/{share_id}` |

All four need admin permission on the Site, as in the portal. Sharing the Site,
changing a share and revoking one also require the Organization that owns the
Site: a recipient cannot pass on or change access it was given, however much
access its share grants. Extension installation credentials cannot manage
shares or keys. `share_site`
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
in and joins as an **editor**, the same role as a portal invite. Through the API
this needs an organization key.

Every invite is stored by the portal and is **single use**: once someone joins
with it, the link stops working, and a person who was removed from the
Organization cannot use the same link to come back. Someone who is already a
member can open it without using it up. In the portal, organization owners and
admins create invites (`POST /api/orgs/invite/generate`, optional `ttlDays`,
`max_uses` from 1 to 50 for a link several people may use, and `email` to
accept only a person signed in with that address). They list them with
`GET /api/orgs/invite` (state, uses, expiry and creator, never the link) and
revoke one with `DELETE /api/orgs/invite/{invite_id}`; a revoked link stops
working immediately, and people who already joined keep their membership.

Invite links created before stored invites were introduced are no longer
accepted, because they could not be revoked. Create a new invite instead.

**Self-hosting:** invites are signed with a key derived from
`FORMS_HMAC_SECRET` and use `PORTAL_PUBLIC_URL` for the link. Without the
secret the route returns `503`.

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

`site_planning`, `content_generation`, `content_improvement` and
`schema_markup` call the model with the Organization's own Anthropic key and
need AI access for the Site. Without it the run fails: `get_workflow` returns
`status: "failed"`, `failure_code: "ai_not_enabled"` and a `failure_reason`
saying the AI assistant is not enabled for this site. (Earlier Core versions
report only `failure_reason`, and their `schema_markup` completes with every
page skipped.) `seo_audit` still returns its issue list without AI
prioritization. See [Built-in AI assistant](#built-in-ai-assistant).

Your own agent does not need that key. The MCP tool descriptions tell an agent
that meets `ai_not_enabled` to do the same work itself instead of retrying:

| Workflow                                 | What your agent does instead                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `site_planning` / `create_site_and_plan` | Plans the pages with the [new-site recipe](../../skills/tr-new-site/), with your approval |
| `content_generation`                     | Writes the page as a draft with the `tr-content-write` recipe                             |
| `content_improvement`                    | Rewrites the weakest published pages as drafts for review (`tr-content-write`)            |
| `schema_markup`                          | Adds structured data with the [structured data tools](../pages/#structured-data-tools)    |

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
before anything is created. An AI plan start checks that the Organization's own
AI key covers new Sites (a key and site access **All sites**); otherwise it
returns `403` with code `ai_not_enabled` and creates nothing.

## Built-in AI assistant

The portal's AI chat uses the Organization's own Anthropic API key on the Sites
an owner or admin chooses. MCP and the API never depend on it.

| Action               | MCP tool                          | API route below `/api/v1`          | Permission       |
| -------------------- | --------------------------------- | ---------------------------------- | ---------------- |
| Read status          | `read_organization_ai_settings`   | `GET /organization/ai`             | Organization key |
| Add or replace a key | `set_organization_ai_key`         | `PUT /organization/ai/key`         | Organization key |
| Remove the key       | `remove_organization_ai_key`      | `DELETE /organization/ai/key`      | Organization key |
| Choose Sites         | `set_organization_ai_site_access` | `PUT /organization/ai/site-access` | Organization key |

A personal connection needs an Organization where the person is an owner or
admin. The key is verified with Anthropic before it is stored and is never
returned; prefer entering it in the portal. Details and error codes are in
[Set up the built-in AI assistant](../../guides/ai-assistant/).

## Publishing connections

GitHub and Cloudflare connection status, disconnecting, connecting Cloudflare
with a customer API token, and finishing media storage are described in
[Connect your accounts](../../guides/customer-publishing/#api-and-mcp).
OAuth sign-in and GitHub App installation remain browser steps:
`read_organization_publishing_connections` returns `connect_urls` for the person
who completes them.

When GitHub is not connected, `diagnose_organization_github_connection`
(`GET /publishing/github-diagnosis`) explains why: the organization's outcome
and each blocker with who must act (`you`, `github_owner`, `publisher` or
`typeroll_admin`) and one action, plus the saved installation once connected. A
person's unfinished attempt and their GitHub accounts stay in their GitHub card.
Relay the message and link to the person; sign-in, installation and account
changes happen at `connect_url`. `recheck: true` re-checks a connected installation with
the App's own access. Every code is explained in
[GitHub connection troubleshooting](../../guides/github-troubleshooting/).

When Cloudflare is not connected, `diagnose_organization_cloudflare_connection`
(`GET /publishing/cloudflare-diagnosis`) explains why for the Organization's
connection or, with `hosting_group_id`, a Hosting Group: the outcome and each
blocker with who must act (`you`, `cloudflare_account_admin`,
`organization_admin`, `publisher` or `typeroll_admin`) and one action, plus the
saved account once connected. An organization API key cannot join a Cloudflare
account another Organization already uses (`claimed_by_other_organization`): an
owner or admin of that Organization connects it in a browser and confirms
sharing it. A
person's unfinished sign-in and the accounts they authorized stay in their
Cloudflare card. `recheck: true` re-verifies a saved connection with its own
authorization. Its `permissions` (and `cloudflare_permissions` in
`read_organization_publishing_connections`) report the optional capabilities
`analytics_provisioning`, `analytics_reports` and `redirect_rules` with their
missing scopes and the one **Approve update** that adds them; see
[Cloudflare permissions](../../guides/customer-publishing/#cloudflare-permissions). Every code is explained in
[Cloudflare connection troubleshooting](../../guides/cloudflare-troubleshooting/).

## Analytics across Sites

| Action                          | MCP tool                      | API route below `/api/v1`      | Permission       |
| ------------------------------- | ----------------------------- | ------------------------------ | ---------------- |
| List Sites with Analytics state | `list_organization_analytics` | `GET /organization/analytics`  | Organization key |
| Turn Analytics on or off        | `set_organization_analytics`  | `POST /organization/analytics` | Organization key |

Approving Cloudflare permissions enables Analytics for no Site. Changes apply
only to the listed Sites, each as `update_app` would, with one result per Site.
Details are in [Analytics](../../apps/analytics/#choose-sites-across-the-organization).

## What stays in the portal

- **Creating an Organization.** An Organization is owned by a signed-in person,
  and an API key belongs to exactly one Organization, so a key cannot create or
  own another one.
- **Joining an Organization and switching between Organizations.** Both act on
  a person's sign-in session. Agents create the invite; the person redeems it.
- **OAuth sign-in** to GitHub and Cloudflare, which is bound to the person and
  browser that start it.
