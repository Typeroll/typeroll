---
name: tr-forms
description: Use when the user wants to add a contact form, newsletter signup, booking form, or other web form to a Typeroll site.
---

# Add a form to a Typeroll site

Typeroll forms are server-backed. The platform renders the form shell, accepts
signed submissions, validates declared fields, stores submissions, and runs
email and webhook actions configured in the portal or through MCP/API.

## Choose the placement

- Block-mode page: add `{ type: 'core/form', data: { form_id } }`.
- HTML-mode page: add `<x-form id="form-id" />` to `html_content`.

Both are authoring references to the same renderer. Static generation expands
them to the complete form HTML, signed token, honeypot, initial step state,
styles, and shared runtime. Previews expand them the same way but in preview
mode (no token, a "Preview – nothing is sent" notice). Never hand-write the
`<form>` shell or paste a token into page HTML.

## Create a simple form

`fields[]` is authoring sugar for one static step:

```json
{
  "id": "newsletter",
  "name": "Newsletter",
  "fields": [
    {"name":"email", "type":"email", "label":"E-postadress", "required":true}
  ],
  "submit_text": "Prenumerera",
  "success_message": "Tack! Du är anmäld."
}
```

`success_message` may contain basic sanitized HTML, such as a link to the next
step. To send the visitor somewhere after the final step instead, set
`success_redirect_url` to a root-relative path (`/tack/`) or an `http(s)` URL,
for example a booking page. Other schemes are rejected; `""` clears it.

Field names must match `[a-z][a-z0-9_-]*`. Labels may be localized. Supported
simple types include `text`, `email`, `tel`, `url`, `number`, `textarea`,
`select`, `radio`, `checkbox`, `hidden`, and `gdpr_consent`.

## Place the form

On a block-mode page:

```
add_block target={kind:'page', id:'start'}
  block={type:'core/form', data:{form_id:'newsletter'}}
```

On an HTML-mode page:

```html
<section class="newsletter-signup">
  <h2>Få våra nyheter</h2>
  <x-form id="newsletter" />
</section>
```

`<x-form>` is not a browser-side shortcode. It is replaced during server
preview/build, so it also supports multi-step forms and never needs inline JS.

## Multi-step form

For a funnel, write `steps[]` directly. Each step is a block tree containing
`form/*` field blocks and optional content blocks:

```
update_form form_id=ansokan patch={steps:[
  {id:'company', title:'Företag', blocks:[
    {type:'form/text', data:{name:'company', label:'Företag', required:true}},
    {type:'form/email', data:{name:'email', label:'E-post', required:true}}
  ]},
  {id:'details', title:'Detaljer', blocks:[
    {type:'form/textarea', data:{name:'message', label:'Meddelande'}},
    {type:'form/consent', data:{name:'consent', text:'<p>Jag godkänner …</p>'}}
  ]}
]}
```

Submissions accumulate in one partial record and become complete on the final
step. Abandoned partials use `partial_ttl_days` (default 30).

Navigation: a step may set `submit_label`; otherwise (render version 5+) every
step but the last reads "Continue"/"Fortsätt" and the last uses `submit_text`.
`allow_back` (default on from render version 5) shows a Back button that keeps
the answers; `show_progress: true | "text" | "bar"` shows "Step X of Y" or a
bar. Give a step a `title` or a leading `form/heading`, not both; the write
returns a `warnings` entry when a step has both.

## Storage and integrations

Completed submissions appear in Forms → Submissions. Admins can configure
actions in the form editor:

- Email notification or autoresponder through the site's email connector.
- Generic webhook to a public HTTPS endpoint. The admin chooses an explicit
  field allowlist and signing secret. Typeroll signs the exact request body in
  `X-Typeroll-Signature`, sends an idempotency key, retries transient failures,
  and stores delivery status.

Agents manage the same actions with `read_form` (actions with secrets masked)
and `update_form patch={ actions: [...] }`, with admin permission as in the
portal. `actions` replaces the whole list: read the form, change what you need
and send the list back. Examples:

```
update_form form_id=contact patch={ actions: [
  { type: "email", config: { to: "hello@example.com", subject: "New lead: {{name}}",
    body: "<p>{{message}}</p>", include_all: true, reply_to: "{{email}}" } },
  { type: "email", config: { to: "{{email}}", subject: "Thanks, {{name}}",
    body: "<p>We will get back to you within a day.</p>" } }
] }
```

An email action with `trigger: "partial_abandoned"` and `after_hours: 2` is
sent once for a multi-step submission that stopped part-way and has not moved
on for two hours (never for completed ones) — opt-in follow-up on leads who
left after step 1.

A webhook needs `url` (https), an explicit `fields` allowlist and a signing
`secret`; send the masked value back to keep a stored secret.
`get_form_capabilities` lists every action type the site offers, including
types from installed apps, with the config fields each one takes.

Email actions send through the site's email provider. Check it with
`get_email_settings`; if `email` is null, connect one with `set_email_settings`
(for example `type: "postmark"`, `from`, `config: { server_token }`) and confirm
with `send_test_email`. Without a provider, submissions are stored but nobody is
notified. These tools need admin permission, like Settings → Email & notifications.

`list_form_submissions` reads what visitors sent, `read_form_submission` reads
one entry (admins also see webhook delivery status) and `delete_form_submission`
removes one.

## Verify

1. `read_form form_id="newsletter"` and confirm the steps/fields.
2. Preview the page (`get_preview_link` or `get_page_preview`) and confirm the
   authoring reference has expanded to a form with `data-tr-form-el` and the
   platform runtime. Click through every step: previews validate, advance steps
   and show the success message (or name the redirect target) like the
   published form, marked "Preview – nothing is sent". They store nothing and
   run no actions, so keep the runtime in any review copy.
3. Submit a real test entry on a deployed page and confirm it appears in
   Forms → Submissions.
4. If a webhook is configured, confirm its delivery status
   (`read_form_submission`) and the receiving system's idempotency key before
   deploying.
5. If an email action is configured, confirm `get_email_settings` shows a
   provider and the test message arrived.

## Common patterns

Newsletter:

```json
{"fields":[{"name":"email","type":"email","label":"E-postadress","required":true}]}
```

Contact:

```json
{"fields":[
  {"name":"name","type":"text","label":"Namn","required":true},
  {"name":"email","type":"email","label":"E-post","required":true},
  {"name":"message","type":"textarea","label":"Meddelande","required":true}
]}
```

Booking request:

```json
{"fields":[
  {"name":"name","type":"text","label":"Namn","required":true},
  {"name":"email","type":"email","label":"E-post","required":true},
  {"name":"time","type":"select","label":"Tid","options":["09:00","10:00","14:00"]},
  {"name":"notes","type":"textarea","label":"Kommentar"}
]}
```

## Pitfalls

- Do not hand-write a form, token, honeypot, or submit script.
- Do not put a raw `<script>` in page HTML; the sanitizer removes it.
- Do not drop existing actions by accident: `actions` replaces the list.
- Do not send every submitted field to a webhook by default; choose the
  smallest allowlist the external register needs.
- `submit_token` is stable until the platform rotates its form-signing secret;
  a rebuild refreshes it after rotation.
