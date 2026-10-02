---
title: Forms Tools
description: Server-backed contact, booking and multi-step forms — HMAC-protected, rate-limited, honeypot-guarded.
---

These tools wrap `/api/v1/sites/{siteId}/forms`, with `/{formId}`, `/{formId}/actions` and `/{formId}/submissions` beneath it,
and `/api/v1/sites/{siteId}/form-capabilities`.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

See [tr-forms](../../skills/tr-forms/) for the full recipe.

## How a form is stored

A form is a list of **steps**. Each step is a group of field blocks shown
together, so a one-page contact form is simply a form with a single step, and a
multi-step funnel is the same structure with more of them.

You rarely need to think about that. Ask for the form you want and the AI agent builds
the right shape:

```
Create a contact form with name, email, phone (optional) and message.
Recipient: hej@acme.se
```

```
Build a three-step quote request: first the property type,
then square metres and timeframe, then contact details.
```

Multi-step forms save partial answers as the visitor advances, so a drop-off
after step one still tells you something.

## `create_form`

Creates a form. Give it fields and a recipient email, and the AI agent wraps them in a
single step for you. For a funnel, describe the steps and it builds them out.

## `read_form`

Returns the form definition and a fresh `submit_token` (HMAC-signed, 24h TTL).
The AI agent fetches this when embedding the form on a page.

## `update_form`

Updates the definition — add or remove fields, reorder steps, change the success
message or recipient.

## After a submission

`success_message` is shown in place of the form when the last step is sent. It
accepts basic formatting and links (for example a booking link), and is
sanitized the same way as page text.

Set `success_redirect_url` to send the visitor on instead — a path on the site
(`/tack/`) or an `https://` address such as a booking page. Other schemes are
rejected, and an empty string clears it. Visitors without JavaScript are
redirected too; a path is resolved against the page the form was on.

## `list_forms`

Returns all forms defined for this site.

## `delete_form`

Deletes a form. Any embed referencing it stops accepting submissions.

## Submissions

| Tool                     | REST                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `list_form_submissions`  | `GET /api/v1/sites/{siteId}/forms/{formId}/submissions`                   |
| `read_form_submission`   | `GET /api/v1/sites/{siteId}/forms/{formId}/submissions/{submissionId}`    |
| `delete_form_submission` | `DELETE /api/v1/sites/{siteId}/forms/{formId}/submissions/{submissionId}` |

`list_form_submissions` reads what visitors sent, newest first, up to 200 per
page (pass `next_cursor` back as `cursor` for the next page).
`read_form_submission` reads one entry. For admins, both also include each
submission's webhook delivery status (`webhook_deliveries`: status, attempts,
response status, last error), as the portal shows it. `delete_form_submission`
removes a single entry (useful for clearing spam or a test submission) together
with its webhook delivery records. `list_forms` includes each form's
`submission_count`. Reading submissions works with read permission; deleting
needs write permission.

## Email notifications and webhooks

A form can email you, send the visitor a confirmation, or post selected fields
to a webhook after every submission. These are the form's `actions`, the same
list the portal's Forms editor manages. Admins read them with `read_form`
(webhook secrets are masked) and set them with `create_form` or
`update_form patch={ actions: [...] }`. The list replaces the current one, so
read the form first and send back every action you keep.

```
update_form form_id=contact patch={ actions: [
  { type: "email", config: { to: "hello@example.com", subject: "New lead: {{name}}",
    body: "<p>{{message}}</p>", include_all: true, reply_to: "{{email}}" } },
  { type: "email", config: { to: "{{email}}", subject: "Thanks, {{name}}",
    body: "<p>We will get back to you within a day.</p>" } }
] }
```

| Type      | Config                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `email`   | `to`, `subject`, `body` (required; `{{field}}` placeholders), `cc`, `bcc`, `reply_to`, `include_all`, `format` (`html` or `text`) |
| `webhook` | `url` (https), `fields` (the field names sent), `secret` (signing secret; send the masked value to keep it)                       |

`include_all` appends every submitted value to the email, one row per field
in the order the fields appear in the form. Each row uses the field's label
(the field name when it has none) and choice fields show the label of the
chosen option. Hidden fields with no value, such as `utm_source` when the
visitor did not arrive from a campaign, are left out. Multi-line answers keep
their line breaks.

Reading and writing actions needs admin permission, as in the portal. With
other permissions `read_form` returns `actions: []` and a write that includes
`actions` is refused with `403`.

### `get_form_capabilities`

Lists every action type the site can use, with the config fields each one
takes: the core `email` and `webhook` types and any type an installed app
provides. It also lists the prefill sources. This is the same list the portal's
Forms editor offers; read it before writing an app-provided action. Admin
permission (`GET /api/v1/sites/{siteId}/form-capabilities`).

### Email provider

Emails go through the site's email provider (Postmark, SMTP or SES), connected
under **Settings → Email & notifications** or with the [email tools](../email/):
`get_email_settings` shows whether one is connected, `set_email_settings`
connects it and `send_test_email` checks it. Without a provider, form email
actions are skipped.

## Rendering

Forms render through the `core/form` block: styled inputs, client-side
validation, and the submit token wired in. You don't hand-write form HTML.

In a multi-step form the browser checks required fields and formats only for
the step that is showing, so a required field in a later step never blocks an
earlier one; it is checked when its step appears. Each step posts only its own
fields, and the server validates them again.

## Forms in previews

Every preview renders forms in preview mode: the editor's preview, **Preview
site**, preview links (`get_preview_link`), page and revision previews and
`get_page_preview`. No page or form setting is needed. A small "Preview –
nothing is sent" notice (Swedish sites: "Förhandsvisning – inget skickas") sits
on the form, and you can click through it as a visitor would:

- each step is validated with the same rules and messages as the server, and
  the next step follows the form's step order and `next` links (dynamic steps
  are shown too);
- the last step shows the success message. With `success_redirect_url` the
  preview names the target ("Preview – would redirect to /tack/") instead of
  leaving the preview;
- nothing is sent: no submission or partial answer is stored, no email,
  webhook or app action runs, and nothing counts towards the submissions inbox.

Preview forms carry no submit token, and the submit endpoint refuses anything
posted from one, so even a preview opened without JavaScript cannot create a
submission. Published pages never contain the preview mode, whatever the URL.
Keep the forms runtime when you build a review copy from `get_page_preview`;
there is nothing to strip or stub. Test real submissions on a deployed page.

## Protection

Every submission passes three checks before it's accepted:

- **HMAC token** — signed when the form is saved, so only your own forms can post
- **Honeypot field** — invisible to humans, filled in by naive bots
- **Rate limit** — per IP, to blunt floods

## Token expiry

The `submit_token` embedded in the form HTML expires after 24 hours. For forms on
long-cached static pages, the AI agent can fetch a fresh token and redeploy. On the
hosted plan, token refresh is automatic.
