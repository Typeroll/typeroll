---
title: Settings Tools
description: Site-wide configuration — colours, fonts, contact info, social links, SEO defaults.
---

These tools wrap `/api/v1/sites/{siteId}/settings`, read and patch the same document.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

## `read_site_settings`

Returns all current site settings.

## `update_site_settings`

Updates site settings. Pass only the fields you want to change. It accepts every
field the portal's **Settings** form does and, like that form, requires admin
permission on the site: a site API key, an organization key for a site your
organization owns, or a share with admin permission. A key with write or read
permission receives HTTP 403. Over REST this is
`PATCH /api/v1/sites/{siteId}/settings`.

### Top-level fields

| Field                      | Type     | Description                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------- |
| `site_name`                | string   | Display name of the site                                         |
| `tagline`                  | string   | Short description, used in SEO and the footer                    |
| `language`                 | string   | BCP 47 language tag: `"sv"`, `"en"`, `"de"`, etc.                |
| `logo`                     | string   | CDN URL for the site logo                                        |
| `favicon`                  | string   | CDN URL for the favicon                                          |
| `apple_touch_icon`         | string   | 180px Apple touch icon                                           |
| `icon_192`                 | string   | 192px application icon                                           |
| `default_seo_suffix`       | string   | Appended to page titles in `<title>`: `" — Acme Studio"`         |
| `default_meta_description` | string   | Site-wide description fallback                                   |
| `default_og_image`         | string   | Fallback `og:image` URL for pages without their own              |
| `twitter_handle`           | string   | X/Twitter handle for `twitter:site`; a leading `@` is removed    |
| `organization`             | object   | Organization JSON-LD; see [`organization`](#organization-object) |
| `staging_url`              | string   | Staging environment URL, reported as `urls.staging`              |
| `trailing_slash`           | string   | `always`, `never`, or `ignore`                                   |
| `iframe_allowed_hosts`     | string[] | Exact hosts allowed in embedded content                          |
| `image_sizes_default`      | string   | Default responsive-image `sizes` hint                            |
| `robots_txt`               | string   | Full content of robots.txt                                       |
| `sitewide_noindex`         | boolean  | Emit `noindex,nofollow` on every HTML page                       |
| `scripts_head`             | string   | Trusted markup/scripts inserted in `<head>`                      |
| `scripts_body_end`         | string   | Trusted markup/scripts inserted before `</body>`                 |
| `custom_css`               | string   | Site-wide CSS                                                    |
| `render_version`           | integer  | Platform render version; see [Render versions](#render-versions) |

An empty string clears `default_og_image`, `twitter_handle` and `staging_url`;
`null` does too. `staging_url` is stored on the site rather than in versioned
settings, so a branch cannot reroute it: it is written the same way whichever
`version` you pass, and trailing slashes are dropped.

### `organization` object

Site-wide Organization structured data, emitted as JSON-LD on every page. The
object replaces the stored value as a whole; send `null` (or empty values) to
remove it.

| Field     | Type     | Description                                         |
| --------- | -------- | --------------------------------------------------- |
| `name`    | string   | Organization name                                   |
| `logo`    | string   | Absolute logo URL                                   |
| `same_as` | string[] | Profile URLs (LinkedIn, X, Facebook, …) as `sameAs` |

```json
{
  "organization": {
    "name": "Acme Studio",
    "logo": "https://media.example.com/logo.png",
    "same_as": ["https://www.linkedin.com/company/acme"]
  }
}
```

### `colors` object

| Field        | Default   | Description           |
| ------------ | --------- | --------------------- |
| `primary`    | `#1a1a2e` | Main brand colour     |
| `secondary`  | `#f8f9fa` | Supporting colour     |
| `accent`     | `#e8c86e` | Pop colour for CTAs   |
| `background` | `#ffffff` | Page background       |
| `surface`    | `#f4f4f6` | Card/panel background |
| `text`       | `#1a1a2e` | Main body text        |
| `text_light` | `#6b7280` | Muted text            |

### `fonts` object

| Field       | Default   | Description                             |
| ----------- | --------- | --------------------------------------- |
| `heading`   | `"Inter"` | Heading font family (Google Fonts name) |
| `body`      | `"Inter"` | Body font family                        |
| `size_base` | `16`      | Base font size in px                    |

### `contact` object

| Field     | Description           |
| --------- | --------------------- |
| `email`   | Contact email address |
| `phone`   | Phone number          |
| `address` | Postal address        |

### `social` object

| Field       | Description             |
| ----------- | ----------------------- |
| `instagram` | Instagram URL or handle |
| `facebook`  | Facebook URL            |
| `linkedin`  | LinkedIn URL            |
| `twitter`   | X/Twitter URL or handle |
| `youtube`   | YouTube channel URL     |

### `cookie_consent` object

The native consent banner is configured through the same bearer-authenticated
settings route and MCP tool:

```json
{
  "cookie_consent": {
    "enabled": true,
    "text": "We use optional cookies.",
    "privacy_policy_url": "/privacy/",
    "scripts_necessary": "",
    "scripts_optional": "<script>startAnalytics()</script>",
    "reload_after_consent": false
  }
}
```

The object is shallow-merged, so omitted fields keep their saved values. In a
signed hosted preview the banner and optional-script gate work, but the frame
has an intentionally opaque origin: the choice is held in memory for the
current preview document and resets on reload/navigation. A published build
uses the normal `tr_consent` cookie.

## Trusted scriptable fields

`scripts_head`, `scripts_body_end`, `custom_css`, and the consent script fields
are readable and writable through v1/MCP for a caller with admin permission on
the site — the same people who can change them in the portal. They are
deliberately trusted, audit-logged surfaces. The chat assistant inside the
portal does not expose them, so a normal editor conversation cannot inject
JavaScript. Review these values like deployed code and redeploy after a change.

### Where `custom_css` loads

Published pages and previews load head CSS in the same order: theme tokens,
content-well rules, block CSS, `custom_css`, the page's own custom CSS, and
then the site template's base stylesheet (reset and global rules). The base
stylesheet defines `:root` tokens such as `--container-narrow`, spacing and
radius values, and the default `body` font and line-height. Because it loads
last, a bare `:root { … }` or `body { … }` rule in `custom_css` does not override
those values; use a more specific selector such as `html:root { … }` or a class
on your own markup.

## `get_site` / `list_sites`

`get_site` returns site metadata (ID, name, slug, domain, language,
`ai_scripts_enabled`, `lifecycle`) plus a `urls` object. `lifecycle.status` is
`active` or `archived`; see [Archive and restore](#archive_site--restore_site).
`list_sites` returns all sites in your account.

The AI agent uses these to confirm which site it's working on before making changes.

### Is my site live?

Read `urls.production` from `get_site`. Non-null means a custom domain is
verified and serving; null means the site is still on its Typeroll subdomain.

There is no site-level "status" field — one existed until 0.30.0, but it was set
when the site was created and never updated afterwards, so it reported live sites
as "planning" forever. It was removed rather than left to mislead. For "has
anything shipped", use `list_deploys`.

## `create_site`

Bootstraps a whole new site — takes a name and an optional domain, and
provisions the hosting project and fallback subdomain.

```
Create a new site called "Lakeside Cafe" for lakesidecafe.se.
```

Requires an **org-scoped** API key. A site-scoped key can only reach the one site
it was issued for, which is the point of the distinction — see
[Install the MCP Server](../../getting-started/mcp-server/).

To start from a WordPress migration or an AI site plan instead of a blank Site,
use `create_site_and_migrate` or `create_site_and_plan` — the other two options
on the portal's **New site** page. See
[Organization, access and workflow tools](../organization/#create-a-site-with-its-first-workflow).

## `update_site`

Changes a site's name, slug, domain, language or `ai_scripts_enabled`. Over REST
this is `PATCH /api/v1/sites/{siteId}`. The slug is uniqueness-checked because it
determines the fallback subdomain. Resubmitting the current slug is idempotent
and repairs missing fallback hosting coordinates, including the Pages project
and DNS record, when the hosting provider is configured.

### Allow AI to write block scripts

`ai_scripts_enabled` is the portal's **Settings → Custom code → Allow AI to write
block scripts** toggle. It decides whether the in-portal chat assistant may write
block JavaScript (`script` on a custom block type, `js` on `core/embed`). Setting
it requires admin permission, exactly as in the portal:

```json
{ "ai_scripts_enabled": true }
```

The toggle does not limit API keys or MCP. Those always write block JavaScript
under the key's own authority, as a site editor can in the portal's block-type
editor, and every write is recorded in the API audit log. See
[Blocks](../blocks/).

## `archive_site` / `restore_site`

Archive a site you are finished with, or bring an archived site back — the same
actions as **Settings → Archive this site** and **Restore this site** in the
portal. See [Archive a site](../../guides/archive-a-site/) for what archiving
does.

- `archive_site` takes an optional `reason`. It is refused with HTTP 409 while a
  custom domain is live or verified on the site.
- `restore_site` makes the site accept changes and publishing again.
- Both are idempotent and require an admin of the organization that owns the
  site: a site API key, or an organization key of the owning organization. A key
  that reaches the site through a share is refused, however much access the
  share grants.

Over REST: `POST /api/v1/sites/{siteId}/lifecycle` with
`{ "action": "archive", "reason": "…" }` or `{ "action": "restore" }`, and
`GET /api/v1/sites/{siteId}/lifecycle` for the current state. The archiving
key is recorded as `api-key:{prefix}`.

## Exporting your content

`export_site` (and **Settings → Export** in the portal) downloads your entire
site as JSON — pages, blocks, partials, content types and templates, settings,
redirects, forms and media metadata.

It's a plain, documented shape rather than a proprietary blob: your content is
yours, and this is the door out. It's also the fastest way to hand a site to
another environment, or to snapshot before a large restructuring.

## Render versions

Platform updates never change how an existing site looks on their own. When
Typeroll changes block markup or shared CSS, the change ships as a new numbered
render version. Each site keeps its version until someone upgrades it. New
sites start on the latest version.

- **In the portal:** Settings → Rendering shows the site's version, what newer
  versions change, **Preview with version N** and **Upgrade**. The preview
  opens the site rendered with the new version. Nothing changes until you
  upgrade, and you can return to the previous version.
- **Through MCP or the API:** `read_site_settings` returns
  `render: { version, latest, upgrades }`. `get_preview_link` accepts
  `render_version` for an upgrade preview, and `update_site_settings`
  with `render_version` applies or reverts it. The `tr-upgrade-rendering`
  recipe compares every page with screenshots in the agent before asking you
  to upgrade.

The preview reflects the change at once; the live site changes at the next
deploy. Sites created before render versions existed render with version 1.

| Version | What changes                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Baseline: block markup and platform CSS as in Core 0.2.56.                                                                                                                                                                                                                                                                                                                        |
| 2       | Heading eyebrow and subtitle are grouped with the heading (`<hgroup>`), take named styles and are never faded. A custom class on a heading or button block lands on the `<h2>` or link itself, so `.my-class .block-heading-text` becomes `.my-class`. Text on primary-coloured buttons is black or white, whichever reads better.                                                |
| 3       | Theme tokens that blocks reference (`--color-bg`, `--color-bg-subtle`, `--color-border`, `--color-secondary-fg`) come from the site palette. Subtle panels such as table headers, code and tabs use the Surface colour instead of a fixed light grey, borders stay visible on dark backgrounds, and text on secondary-coloured buttons is black or white, whichever reads better. |

## Site-specific responsive widths (Core 0.2.28)

The five names stay the same, but their widths can be set in **Site settings →
Typography → Responsive block widths**, or through `update_site_settings`:

```json
{
  "responsive_breakpoints": {
    "tablet": 576,
    "laptop": 769,
    "desktop": 1024,
    "wide": 1280
  }
}
```

Send all four increasing integer widths (320–2560px); `null` restores
640/1024/1280/1536px. Values are versioned with the site's settings. Responsive
block fields, repeater item overrides and `hidden_on` use these widths in the
editor preview and static output. Reload an open editor after changing them.
Republish to update live pages; changing widths invalidates rendered-page caches.

This does not change explicit menu `collapse_below`, grid `stack_at`, listing
mobile defaults or theme typography thresholds. Set the menu threshold separately
when it must match, and use explicit responsive `cols` for exact listing columns.
Check one pixel below and at each threshold, including fractional widths for
visibility. Do not hide layout overflow to make a test pass.
