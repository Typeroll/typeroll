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
| `default_seo_suffix` | string | Appended to page titles in `<title>`: `" — Acme Studio"` |
| `robots_txt`         | string | Full content of robots.txt                               |

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

## What Claude cannot change via settings

For security, these fields are not writable through the AI chat or the MCP server:

| Field              | How to change                                 |
| ------------------ | --------------------------------------------- |
| `scripts_head`     | Portal UI: **Settings → Analytics / Scripts** |
| `scripts_body_end` | Portal UI: **Settings → Analytics / Scripts** |
| `custom_css`       | Portal UI: **Settings → Custom CSS**          |

These fields accept arbitrary HTML/JS and are therefore restricted to the portal UI, where a human explicitly pastes the code.

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
