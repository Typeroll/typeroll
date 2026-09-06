---
title: Settings Tools
description: Site-wide configuration — colours, fonts, contact info, social links, SEO defaults.
---

## `read_site_settings`

Returns all current site settings.

## `update_site_settings`

Updates site settings. Pass only the fields you want to change.

### Top-level fields

| Field                | Type   | Description                                              |
| -------------------- | ------ | -------------------------------------------------------- |
| `site_name`          | string | Display name of the site                                 |
| `tagline`            | string | Short description, used in SEO and the footer            |
| `language`           | string | BCP 47 language tag: `"sv"`, `"en"`, `"de"`, etc.        |
| `logo`               | string | CDN URL for the site logo                                |
| `favicon`            | string | CDN URL for the favicon                                  |
| `apple_touch_icon`   | string | 180px Apple touch icon                                   |
| `icon_192`           | string | 192px application icon                                   |
| `default_seo_suffix` | string | Appended to page titles in `<title>`: `" — Acme Studio"` |
| `default_meta_description` | string | Site-wide description fallback                    |
| `trailing_slash`     | string | `always`, `never`, or `ignore`                           |
| `iframe_allowed_hosts` | string[] | Exact hosts allowed in embedded content              |
| `image_sizes_default` | string | Default responsive-image `sizes` hint                  |
| `robots_txt`         | string | Full content of robots.txt                               |
| `sitewide_noindex`   | boolean | Emit `noindex,nofollow` on every HTML page              |
| `scripts_head`       | string | Trusted markup/scripts inserted in `<head>`              |
| `scripts_body_end`   | string | Trusted markup/scripts inserted before `</body>`         |
| `custom_css`         | string | Site-wide CSS                                             |

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
are readable and writable through v1/MCP for a caller holding the site's API
key. They are deliberately trusted, audit-logged surfaces. The chat assistant
inside the portal does not expose them, so a normal editor conversation cannot
inject JavaScript. Review these values like deployed code and redeploy after a
change.

## `get_site` / `list_sites`

`get_site` returns site metadata (ID, name, domain, creation date) plus a `urls`
object. `list_sites` returns all sites in your account.

Claude uses these to confirm which site it's working on before making changes.

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
[Install the MCP Server](/getting-started/mcp-server/).

## `update_site`

Changes a site's name, slug or domain. The slug is uniqueness-checked because it
determines the fallback subdomain.

## Exporting your content

`export_site` (and **Settings → Export** in the portal) downloads your entire
site as JSON — pages, blocks, partials, collections and their items, settings,
redirects, forms and media metadata.

It's a plain, documented shape rather than a proprietary blob: your content is
yours, and this is the door out. It's also the fastest way to hand a site to
another environment, or to snapshot before a large restructuring.
