# Building the directory edit form

Enabling the directory app installs everything the self-service edit flow
needs: two forms, a block for each, and the endpoints behind them. What you
decide is which FIELDS the listed business may change — that's the step that
matters, and it's the first one below.

Everything below assumes the listings live in a collection called `companies`
with a contact field called `email`. Substitute your own names.

## 1. Decide which fields the business may edit

This is the step that actually matters, and it's opt-in per field. A field with
no `writable_by` is `['portal','agent']` — the business cannot touch it, which
is the safe default for every collection that existed before you turned this
on.

```jsonc
// collection schema
{
  "name": "companies",
  "fields": [
    { "name": "title",  "label": "Name",        "type": "text",
      "writable_by": ["portal", "owner", "agent"] },
    { "name": "phone",  "label": "Phone",       "type": "text",
      "writable_by": ["portal", "owner"] },
    { "name": "description", "label": "About",  "type": "textarea",
      "writable_by": ["portal", "owner", "agent"] },

    // Not listed → the business can't edit it and never sees it in the form.
    { "name": "email",  "label": "Contact email", "type": "email" },

    // Billing state. Only your own server logic writes this.
    { "name": "plan",   "label": "Plan",        "type": "text",
      "writable_by": ["app"] },

    // Agent working state. Never rendered, never in the build snapshot.
    { "name": "last_outreach", "label": "Last outreach", "type": "date",
      "writable_by": ["agent"], "rendered": false }
  ]
}
```

Two consequences worth internalising:

- **`status` is not editable through this surface at all.** A business cannot
  publish or unpublish its own listing, no matter how you configure fields.
- **Precedence outranks the field list.** Once the business writes `phone`, an
  agent write to `phone` is refused with a 409 naming the field. That's the
  point — but it means your enrichment agent needs to expect 409s and treat
  them as "already handled", not as an error to retry.

## 2. Enable the app + an email connector

`/app/sites/{id}/settings/apps` → **Directory**:

| Field | Value |
|---|---|
| Listings collection | `companies` |
| Contact email field | `email` |
| Link lifetime (hours) | `48` |

Then `/app/sites/{id}/settings/integrations` → an email connector. **Without
one no mail is sent and the request endpoint stays silent about it** — the
same 202 as every other outcome. Check the connector first when links don't
arrive.

The connector's From address is what the business sees, so the mail is your
directory's brand, not Typeroll's.

## 3. Place the forms

**You don't build them.** Enabling the app seeds two forms and registers a
block for each, so they appear in the editor's block picker and to the agent:

| Block | What it does |
|---|---|
| **Request edit link** | The business enters its listing id and the address on file; a one-time link is mailed there. |
| **Edit listing** | Opens from that link, prefilled with current values, saves back the owner-writable fields. |

Drop them on a page (one page or two — your call) and you're done. The
endpoint, the session handling and the prefill are all app-owned; nothing to
configure.

### Adding fields

The app ships a minimal base — `title` on the edit form. Everything else is
yours. Open the seeded form in the forms UI and add `form/*` fields whose
**`name` matches the collection field** you want editable. A field with no
matching collection field is ignored by the endpoint, and a field the
collection didn't mark `writable_by: ['owner', …]` is refused, so adding a
field to the form is never enough on its own — step 1 is the real gate.

Re-enabling the app never overwrites what you added. Disabling removes the
blocks from the picker but keeps the forms and their fields.

### Adding actions

`Form.actions` composes across sources. A directory edit can send a
confirmation email (core), post to Slack (a Slack app), and enqueue
moderation (an app that provides it) from one list — the editor lists every
registered type and renders its settings. Actions that declare a pre-submit
hook can also refuse a submission outright; the editor marks those "can block
submit".

### Adding prefill sources

`Form.prefill` is the same idea for initial values. The edit form ships with
`directory/listing`; you can add `query` (fill from URL parameters) or
`constant` after it. Sources compose in order with later winning — but the
**record always wins over all of them**, so a source can only fill fields the
listing left empty.

## 4. Deployment remains static

The endpoints are on the portal and **work immediately**. The form calls them
cross-origin; the portal answers with CORS headers computed from the site's own
domain, so nothing needs an allowlist and nothing needs a deploy.

The published page always calls the portal endpoint directly and carries the
editing session as a tab-scoped bearer token. Enabling Directory never emits a
Pages Function or reverse proxy into the customer hosting project.

## 5. Keep the page out of the index

On the page's SEO settings, set **noindex**. It's a utility page with a token
in its URL; it has no business ranking. Also worth adding to `scripts_head`:

```html
<meta name="referrer" content="no-referrer">
```

so the token can't leak through the `Referer` header to any third-party
resource on the page before the JS strips it.

## What to check when it doesn't work

| Symptom | Cause |
|---|---|
| Request form always says "on its way", no mail | No email connector configured, or the address doesn't match the item's `email` field exactly (compared lowercased and trimmed) |
| `/api/directory/*` 404s on your own domain | The form action is stale; it must use the absolute portal URL, not a same-origin path |
| CORS error in the console | The page isn't on the site's declared `domain` (or its `www.`/fallback subdomain). The portal only echoes origins it can derive from the site doc |
| Link works once, then 401 | Correct. Grants are single-use; the cookie carries the session afterwards |
| 401 mid-edit | The grant was revoked, or the hour-long session cookie expired |
| 403 mid-edit | The app was disabled while a session was open |
| Field missing from the form | Either it isn't on the form, or the collection field isn't `writable_by: ['owner', …]` — both are required, and the form only ever shows what it can write |
| An action you added disappeared on save | Should no longer happen; if it does, the type isn't in the action registry (the save path refuses unknown types deliberately) |
| Saves succeed but the site doesn't change | Auto-deploy is off (`Site.auto_deploy.enabled`), or you're inside the debounce window |

## How this was verified

Honest inventory, because "tests pass" and "this works" aren't the same claim:

- **Unit + integration (1546 tests).** The grant lifecycle (single-use,
  expiry, revocation, uniform error messages), the edit session end-to-end
  against a real fixtures datastore (field filtering, `status` refusal,
  409 on precedence loss, mid-session revoke and app-disable), and the
  direct CORS and bearer-token path.
- **Real astro build (smoke).** Taxonomy routes with the `min_items` guard
  actually firing, facet scope inheritance, and `core/embed`'s JS landing
  outside the sanitized body. This scenario found a genuine defect while
  being written — see below.
- **The cross-listing attack, driven directly.** Hold a valid link to one
  listing, add `item_id` / `id` / `listing` / `listing_id` / `item` naming
  another, and assert the response is still the first listing's and never
  contains the other's data. Plus a source-level test that the route reads no
  query parameter beyond the signed token and `form`, so a third one can't
  appear unnoticed.
- **Not verified end-to-end:** no Playwright run against a live dev server.
