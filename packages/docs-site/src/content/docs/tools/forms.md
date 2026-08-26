---
title: Forms Tools
description: Server-backed contact, booking and multi-step forms — HMAC-protected, rate-limited, honeypot-guarded.
---

See [tr-forms](/skills/tr-forms/) for the full recipe.

## How a form is stored

A form is a list of **steps**. Each step is a group of field blocks shown
together, so a one-page contact form is simply a form with a single step, and a
multi-step funnel is the same structure with more of them.

You rarely need to think about that. Ask for the form you want and Claude builds
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

Creates a form. Give it fields and a recipient email, and Claude wraps them in a
single step for you. For a funnel, describe the steps and it builds them out.

## `read_form`

Returns the form definition and a fresh `submit_token` (HMAC-signed, 24h TTL).
Claude fetches this when embedding the form on a page.

## `update_form`

Updates the definition — add or remove fields, reorder steps, change the success
message or recipient.

## `list_forms`

Returns all forms defined for this site.

## `delete_form`

Deletes a form. Any embed referencing it stops accepting submissions.

## Submissions

`list_form_submissions` reads what visitors sent; `delete_form_submission`
removes a single entry (useful for clearing spam or a test submission).

## Email notifications

A form can email you on every submission. Connect a provider (Postmark or plain
SMTP) per site under **Settings → Email** in the portal. Credentials are
encrypted at rest and deliberately kept off the agent surface — Claude can author
the form and its email action, but cannot read or set your provider credentials.

## Rendering

Forms render through the `core/form` block: styled inputs, client-side
validation, and the submit token wired in. You don't hand-write form HTML.

## Protection

Every submission passes three checks before it's accepted:

- **HMAC token** — signed when the form is saved, so only your own forms can post
- **Honeypot field** — invisible to humans, filled in by naive bots
- **Rate limit** — per IP, to blunt floods

## Token expiry

The `submit_token` embedded in the form HTML expires after 24 hours. For forms on
long-cached static pages, Claude can fetch a fresh token and redeploy. On the
hosted plan, token refresh is automatic.
