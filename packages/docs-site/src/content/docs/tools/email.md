---
title: Email Tools
description: Connect, test and disconnect the site's email provider for form notifications, and turn incoming email forwarding on or off, through MCP or the API.
---

These tools manage the same settings as **Settings → Email & notifications** in the portal: the
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
or a missing required field returns `400`. Secrets are encrypted at rest and are
write-only: omit a secret field (or send the masked value `••••••••`) to keep the
stored one. A server without `INTEGRATIONS_SECRET_KEY` refuses the write with
`503`; on Typeroll Cloud this is configured for you, and on a self-hosted
install you set it in the server environment.

### `send_test_email`

Sends a test message through the stored provider: `send_test_email to="you@example.com"`.
Save the provider first. A provider error is returned as `502` with its message.

### `delete_email_settings`

Disconnects the provider and deletes its stored credentials. Form email actions
are skipped until a provider is connected again. Form actions themselves are
not changed.

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
