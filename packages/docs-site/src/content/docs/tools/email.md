---
title: Email Tools
description: Configure Site and shared Organization email accounts, campaign limits, tests and incoming forwarding through MCP or the API.
---

These tools manage the same settings as **Settings → Integrations → Email & notifications** in the portal: the
outgoing email provider that form notifications send through, and forwarding
for incoming email. They need **admin permission** on the site, just like the
portal page. An owned site's API key and a site-scoped key are admin; a shared
site follows the share's permission. App installation credentials cannot use
them, except that an app with the `email:inbound:status` scope can read its own
incoming routes and receipts.

| Tool                            | REST                                                      |
| ------------------------------- | --------------------------------------------------------- |
| `get_email_settings`            | `GET /api/v1/sites/{siteId}/integrations/email`           |
| `set_email_settings`            | `PUT /api/v1/sites/{siteId}/integrations/email`           |
| `delete_email_settings`         | `DELETE /api/v1/sites/{siteId}/integrations/email`        |
| `send_test_email`               | `POST /api/v1/sites/{siteId}/integrations/email/test`     |
| `get_incoming_email_settings`   | `GET /api/v1/sites/{siteId}/delivery/inbound`             |
| `set_incoming_email_forwarding` | `PUT /api/v1/sites/{siteId}/delivery/inbound`             |
| `read_incoming_email_receipt`   | `GET /api/v1/sites/{siteId}/delivery/inbound/{receiptId}` |

## Outgoing email provider

The account-sharing and campaign-limit options below require Extension runtime
**0.47.0 or later**. Check the runtime installed by your host; older releases
provide only each Site's own account. These options are prepared for that
release and do not change an existing Cloud installation until it is upgraded.

Each Site chooses its own outgoing account and campaign budget in **Settings →
Integrations → Email & notifications**. An Organization owner can configure a
shared account under **Account settings → Organization email** and explicitly
allow individual Sites to use it. New Sites receive no access automatically.
The Site administrator then chooses the Organization account; granting access
alone does not switch the Site's sender.

Shared credentials remain at Organization level. Site reads expose only the
shared sender and whether access is available. Rotation takes effect for future
sends. Withdrawing access stops future sends through that account, with no
automatic fallback. A send already in progress may finish. The Site may retain
its own account while using the shared account.

`get_email_settings` additionally returns `source` (`site`, `organization` or
`none`), `site_email` (the masked Site account), `organization_email` (safe grant
metadata) and `bulk_email`:

```json
{ "daily_limit": 10, "minimum_interval_minutes": 15 }
```

Use `set_email_settings source="organization"` to select an available shared
account, or `source="site"` for the Site account. Use
`set_email_settings bulk_email={daily_limit:10,minimum_interval_minutes:15}`
to save campaign limits independently of account credentials. The daily range
is 0–10,000; 0 stops campaign sending. The interval is 1–1,440 minutes. These
limits apply across the Site's apps, including when Sites share one account.
The day resets at midnight UTC. Provider limits still apply. Transactional
mail, such as confirmations and user-requested edit links, uses its separate
allowance and does not consume this campaign budget.

Organization tools require a current **owner**, through a personal connection
or an Organization API key issued by a current owner. Site keys and keys issued
by an administrator cannot manage shared credentials or grants.

| Tool                                 | REST                                |
| ------------------------------------ | ----------------------------------- |
| `get_organization_email_settings`    | `GET /api/v1/organization/email`    |
| `set_organization_email_settings`    | `PUT /api/v1/organization/email`    |
| `remove_organization_email_settings` | `DELETE /api/v1/organization/email` |
| `send_organization_test_email`       | `POST /api/v1/organization/email`   |

Read the Organization settings first. Writes and disconnects require its
`revision` as `expected_revision`; a conflict requires reloading and reviewing
the current grants. The set tool accepts provider `type`, `from`, `reply_to`,
`config` and an explicit `allowed_site_ids` array. Omitted fields are preserved;
an empty array withdraws every grant. Disconnecting removes the shared account
and all grants. The test tool takes one `to` address and sends one test only
when requested; it does not start a campaign.

Form email actions (notifications and visitor confirmations, see
[Forms](../forms/#email-notifications-and-webhooks)) send through one provider
per site. Without one, submissions are still stored but nobody is notified, and
the migration preflight warns about it.

### `get_email_settings`

Returns the connector, the available providers with their field schema, and
`crypto_configured` (whether the server can store secrets):

```json
{
  "email": {
    "type": "postmark",
    "from": "Acme <hello@acme.com>",
    "reply_to": "",
    "config": { "server_token": { "set": true }, "message_stream": "outbound" }
  },
  "providers": [{ "type": "postmark", "label": "Postmark", "fields": [ ... ] }],
  "crypto_configured": true
}
```

`email` is `null` when nothing is connected. Secret fields are never returned,
only `{ "set": true }` or `{ "set": false }`.

### `set_email_settings`

Connects a provider or changes it. Read `get_email_settings` first and use the
field keys from the provider's schema:

```
set_email_settings type="postmark" from="Acme <hello@acme.com>"
  config={ server_token: "…", message_stream: "outbound" }

set_email_settings type="smtp" from="hello@acme.com" reply_to="support@acme.com"
  config={ host: "smtp.example.com", port: 587, secure: false, user: "hello@acme.com", password: "…" }
```

| Provider | `config` fields                                                                  |
| -------- | -------------------------------------------------------------------------------- |
| Postmark | `server_token` (secret, required), `message_stream`                              |
| SMTP     | `host` (required), `port`, `secure`, `user`, `password` (secret)                 |
| SES      | `region`, `access_key_id` and `secret_access_key` (secrets), `configuration_set` |

Validation is the same as in the portal: an unknown provider, a missing `from`
or a missing required field returns `400`. An SMTP `port` must be 26, 465, 587,
2465, 2525 or 2587 (port 25 is not offered: the Workers that send mail cannot
open it), and `host` must resolve to a public address; private, loopback and
`.local`/`.internal` hosts are refused when saving and sending. Secrets are encrypted at rest and are
write-only: omit a secret field (or send the masked value `••••••••`) to keep the
stored one. A server without `INTEGRATIONS_SECRET_KEY` refuses the write with
`503`; on Typeroll Cloud this is configured for you, and on a self-hosted
install you set it as a Worker secret (see
[Self-hosting](../../guides/self-hosting/)).

### `send_test_email`

Sends a test message through the stored provider: `send_test_email to="you@example.com"`.
Save the provider first. A provider error is returned as `502` with its message.

### `delete_email_settings`

Disconnects the provider and deletes its stored credentials. Form email actions
are skipped until a provider is connected again. Form actions themselves are
not changed.

When the Site selected a shared Organization account, disconnecting deselects
it for this Site. It does not delete the Organization account or the Site's
preserved own credentials.

## Incoming email forwarding

A hosting administrator first approves a receiving address (alias) and its
forwarding target; see [Incoming email and forwarding](../../guides/incoming-email/).
Agents and the API can then do what the portal's toggle does, and nothing more:
they cannot create aliases or change targets.

- `get_incoming_email_settings` lists the approved routes with their `alias`,
  `target`, current `revision`, whether forwarding is `enabled`, and the last
  receipt with its delivery status. An empty list means no address is approved.
- `set_incoming_email_forwarding route_id="replies" revision="<revision>" enabled=true`
  turns forwarding on or off. Pass the revision you just read: if the host
  changed the route in the meantime the call returns `409`, and the new route
  must be reviewed before it is enabled.
- `read_incoming_email_receipt receipt_id="<64 hex>"` reads one receipt's status
  (`forwarded`, `held`, `blocked`, …), reason and delivery status. Receipts
  contain no subject, sender or body.

Enable forwarding, send a real test message, and only then change the site's
Reply-To address.
