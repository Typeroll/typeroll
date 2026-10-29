---
title: Settings Tools
description: Site-wide configuration — colours, fonts, contact info, social links, SEO defaults.
---

These tools wrap `/api/v1/sites/{siteId}/settings`, read and patch the same document.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

## Find settings in the portal

The section navigation below is available from Core 0.2.101.

Open your Site → **Settings**, then choose a section. On mobile, use the
**Settings section** selector.

| Section      | What you can change                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------ |
| General      | Site name, tagline, logo and icons                                                               |
| Design       | Colors, typography, responsive widths, image sizes and render version                            |
| SEO          | Search visibility, title suffix, sharing metadata, structured data, paths and publication checks |
| Publishing   | Hosting Group, website/media domains and preview address                                         |
| Integrations | Core modules, email, owner review and cookie consent                                             |
| Access & AI  | Sharing, API keys, site instructions and AI script permission                                    |
| Advanced     | Custom scripts, iframe hosts, archiving and content export                                       |

Switching sections keeps your unsaved form edits while you stay on this page.
**Save** saves only the selected section and confirms the result inline. Save
each edited section before leaving or reloading. Settings are tied to the
selected Site version unless a field is explicitly site-wide, such as the
preview address. Publish to apply changes to the public site.

Domains, rendering upgrades and access controls have their own actions. Saving
general settings does not change the live domain or publish the website.
Organization connections are separate: **Publishing → Open Publishing** takes
an Organization owner/admin to shared GitHub, Cloudflare and media settings.
REST/MCP callers still use the same settings tools and submit only changed fields.

## `read_site_settings`

Returns all current site settings.

## `update_site_settings`

Pass settings at the top level, for example
`{"site_id":"your-site","tagline":"Your new tagline"}`. Unlike `update_page`,
this tool has no `patch` envelope. MCP rejects unknown top-level arguments
(including `patch` or `settings`) and requests with no settings to change.
An empty string is an intentional value, for example to clear the tagline.
This validation applies to full and compact MCP connections.

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

### Form submission retention

`form_submission_retention_days` (integer 30–3650, or `null`) sets how long
completed form submissions are kept. It is off by default: `null` keeps them
until someone deletes them. With a value, each completed submission is deleted
that many days after it was completed, on every form of the site, including
submissions received before you set it; those already older are deleted at once
and cannot be restored. The response reports
`form_submission_retention: { updated, deleted }`. Setting `null` again stops
further deletion. Like `staging_url`, the value is stored on the site, not per
version, and `read_site_settings` returns it with the other settings.

Only a site administrator can change it. Extension credentials receive HTTP 403
even with `content:write`. In the portal, set it under **Forms → Submission
retention**. See [Forms privacy and retention](../../apps/forms/#privacy-and-retention).

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

| Field          | Default   | Description                                              |
| -------------- | --------- | -------------------------------------------------------- |
| `primary`      | `#2563eb` | Main brand colour                                        |
| `secondary`    | `#1e293b` | Supporting colour                                        |
| `accent`       | `#f59e0b` | Pop colour for CTAs                                      |
| `background`   | `#ffffff` | Page background                                          |
| `surface`      | `#f8fafc` | Card/panel background                                    |
| `text`         | `#0f172a` | Main body text                                           |
| `text_light`   | `#64748b` | Muted text                                               |
| `on_primary`   | unset     | Text colour on primary; unset is automatic. See below.   |
| `on_secondary` | unset     | Text colour on secondary; unset is automatic. See below. |
| `on_accent`    | unset     | Text colour on accent; unset is automatic. See below.    |

### Text on theme colours

Buttons, badges, tabs, call-to-action sections and styles using the
`on_primary`, `on_secondary` or `on_accent` colour tokens put text on a theme
colour. By default that text is near-black (`#111827`) or white, whichever
reads better: chosen by [APCA](../styles/#readable-text) from render version 8,
by the WCAG 2 contrast ratio before. In the portal, **Settings → Colors → Text
on primary/secondary/accent** shows the colour in use with both measures.

To use a brand's own choice, choose a colour there or send a hex colour
(`#rgb` or `#rrggbb`) through `update_site_settings`; `null` returns to the
automatic choice:

```json
{ "colors": { "secondary": "#00a19c", "on_secondary": "#ffffff" } }
```

A chosen colour applies on every render version and is published with the
site. Use it instead of custom CSS. When the palette or render version
changes, the response lists `on_colors` with each text colour, its APCA Lc and
WCAG 2 ratio. A chosen colour below APCA Lc 60, the minimum for button text
(16px at weight 600), is kept and returned as a warning with both measures,
together with the automatic alternative.

### `fonts` object

| Field       | Default   | Description                                                                                                                                                                                                             |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heading`   | `"Inter"` | Heading font family (Google Fonts name)                                                                                                                                                                                 |
| `body`      | `"Inter"` | Body font family                                                                                                                                                                                                        |
| `size_base` | `16`      | Base font size in px, from 12 to 24                                                                                                                                                                                     |
| `smoothing` | unset     | `auto` (browser default) or `antialiased`. Unset is `auto` from render version 6 and `antialiased` before it. `antialiased` draws thinner text on macOS and can suit light text on a dark background; `null` clears it. |

### `typography` and `design_scales`

Available in Core 0.2.114 / MCP 0.45.85. Render version 10 provides fluid defaults.
In **Site settings → Design**, preview your saved role styles and unsaved scale
controls at 375, 768 and 1280px before saving.

| Setting                    | Default | Range / purpose                                 |
| -------------------------- | ------- | ----------------------------------------------- |
| `typography.ratio_mobile`  | `1.2`   | 1.1–1.5; narrow-screen heading scale            |
| `typography.ratio_desktop` | `1.25`  | 1.1–1.5; wide-screen heading scale              |
| `typography.rhythm`        | `1`     | 0.5–2; spacing and proportional heading margins |
| `typography.line_length`   | `65`    | 40–90 characters; prose measure                 |

Set these fields at the top level of `update_site_settings` alongside `fonts`.
`design_scales.type_size`, `.space` and `.leading` customize named steps.
A length step accepts a length, a bounded `clamp`, or a responsive map:

```json
{
  "typography": {
    "ratio_mobile": 1.2,
    "ratio_desktop": 1.25,
    "rhythm": 1,
    "line_length": 65
  },
  "design_scales": {
    "space": {
      "lg": {
        "mobile": "1.5rem",
        "desktop": "clamp(1.5rem, 1rem + 1vw, 2.5rem)"
      }
    }
  }
}
```

Role styles must refer to steps such as `2xl` and `lg` to follow the scale.
Existing fixed sizes and explicit part styles keep their precedence. Upgrading
a render version does not overwrite saved styles. See [Design tokens](../../guides/design-tokens/)
for the step names, accepted syntax and migration procedure.

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
    "reload_after_consent": false,
    "labels": {
      "title": "Cookies auf dieser Website",
      "accept_all": "Alle akzeptieren"
    }
  }
}
```

The banner's heading, buttons, privacy link and settings label follow the
page language (`Page.language`, otherwise the site `language`): Swedish for
`sv`, German for `de`, otherwise English. The default `text` follows the same
rule. Set `labels` only to replace that wording, for example for another
language. Its keys are `title`, `reject`, `necessary`, `accept_all`,
`privacy_link` and `manage`. Values are plain text of at most 120 characters,
and blank values use the built-in wording. `labels` is replaced as a whole.

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
this is `PATCH /api/v1/sites/{siteId}`. Changing `slug` or `domain` requires
admin permission on the site (`403` otherwise): the slug determines the fallback
subdomain and the domain becomes the canonical URL of every build. Name and
language need write permission.

The slug is uniqueness-checked within the Organization, and its fallback
subdomain is reserved across the whole platform: a slug whose fallback
subdomain another site already uses is refused with `409` and code
`slug_unavailable`, and the site keeps its current slug. Typeroll never
re-points a fallback subdomain whose DNS record or hosting attachment belongs
to another site. Sites that publish to the Organization's own Git repository
get no platform fallback subdomain. Resubmitting the current slug is idempotent
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

| Version | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Baseline: block markup and platform CSS as in Core 0.2.56.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2       | Heading eyebrow and subtitle are grouped with the heading (`<hgroup>`), take named styles and are never faded. A custom class on a heading or button block lands on the `<h2>` or link itself, so `.my-class .block-heading-text` becomes `.my-class`. Text on primary-coloured buttons is black or white, whichever reads better.                                                                                                                                                                 |
| 3       | Theme tokens that blocks reference (`--color-bg`, `--color-bg-subtle`, `--color-border`, `--color-secondary-fg`) come from the site palette. Subtle panels such as table headers, code and tabs use the Surface colour instead of a fixed light grey, borders stay visible on dark backgrounds, and text on secondary-coloured buttons is black or white, whichever reads better.                                                                                                                  |
| 4       | Lists in core blocks render: accordion items (with **Default open**), pricing plan features and team member social links. An icon without a link no longer sits in an empty link, a team member card is a link only when it has one, and a container set to link without an address renders as a plain container, so icons and cards work inside linked items.                                                                                                                                     |
| 5       | Multi-step forms: the button reads "Continue" ("Fortsätt" on Swedish sites) on every step but the last, which keeps the form's submit text; a "Back" button returns to the previous step with the answers kept; a step that starts with a form heading no longer also shows its step title. See [Multi-step forms](../forms/#multi-step-forms).                                                                                                                                                    |
| 6       | Text uses the browser's default font smoothing and text rendering. Earlier versions set `-webkit-font-smoothing: antialiased` and `text-rendering: optimizeLegibility` on every page, which on macOS draws dark text on a light background thinner and lighter than other sites at the same weight. Choose **Typography → Font smoothing → Antialiased** (`fonts.smoothing`) to keep the thinner rendering, for example for light text on a dark background; the choice applies on every version.  |
| 7       | Video, ratings and carousels: `core/video` embeds YouTube (no-cookie) and Vimeo addresses and plays video files with poster, autoplay, loop, muted, controls and lazy loading; a hero plays a video file as a muted background with a pause button; a testimonial rating shows as stars; carousels get previous/next buttons, dots and optional autoplay with pause. Nothing moves for visitors who prefer reduced motion. See [Blocks](../blocks/#video-hero-video-and-ratings-render-version-7). |
| 8       | Text on primary, secondary and accent (buttons, badges, tabs, call-to-action sections) is black or white by APCA instead of the WCAG 2 ratio. On mid-dark saturated colours such as teal, green or medium blue, near-black text becomes white, which reads better: white on `#00a19c` is APCA Lc 63.9 against Lc 44 for `#111827`. A text colour chosen in `colors.on_*` applies on every version and does not change. See [Text on theme colours](#text-on-theme-colours).                        |
| 9       | A container with a shadow (`shadow: "subtle"` or `"header"`) is raised above the blocks after it (`position: relative; z-index: 10`), so the next block's background or image no longer covers the shadow, and menus that open from a shadowed header land above the next block. A sticky container keeps z-index 100. The container becomes the containing block of its absolutely positioned content. The header shadow is `0 2px 6px` instead of `0 2px 5px`. See [Blocks](../blocks/).         |
| 10      | Fluid typography and spacing scales, proportional editorial heading margins, no role margin on component titles or opening headings, and a configurable prose measure.                                                                                                                                                                                                                                                                                                                             |

## Site-specific responsive widths (Core 0.2.28)

The five names stay the same, but their widths can be set in **Site settings → Design →
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

## Scripts in previews

Script-enabled signed previews include `scripts_head` and `scripts_body_end`
from the selected version, as the static renderer does. They run in an
opaque-origin sandbox and cannot access the portal session or storage. A widget
that requires a real first-party origin may still need a test publication.
Script-disabled preview surfaces omit these snippets. Custom scripts may make
external requests, including analytics calls; only add code you intend to run
in previews. Typeroll's built-in analytics remain excluded from previews.
For a widget on one page, use a page-local `core/embed` block instead of a
site-wide script with a pathname condition.

### Published site icons

**Prepared for Core 0.2.122.** Upload your icon to the site's media library and
set `favicon` to that media URL. Publication generates a real `/favicon.ico`
with 16, 32 and 48 pixel images, preserving the complete motif and transparency.
Every published HTML page links to a content-hashed copy. Changing the icon and
publishing again changes that link, including on pages whose HTML was reused.
No custom code or manual ICO conversion is needed.

`icon_192` supplies the 192 pixel image in `/site.webmanifest`. If it is absent,
Typeroll generates that image from the favicon. A site without either setting
receives a small transparent fallback icon, so `/favicon.ico` does not return
an HTML error page. `apple_touch_icon` remains a separate setting.

Use PNG, SVG, JPEG, WebP or ICO (PNG-backed or uncompressed Windows bitmap entries).
For customer builds, both icon settings must reference uploaded media included
in the frozen publication. Invalid or unavailable configured images fail with
`site_icon_build_failed`; Typeroll does not silently publish a different icon.

The fixed `/favicon.ico` and `/site.webmanifest` addresses use the publication's
revalidation policy. Hashed icon files can be cached immutably. A new deployment
cannot remotely clear an old WordPress favicon already cached by a browser for
years. The new HTML icon URL avoids that old cache on subsequent page visits;
saved bookmarks and pinned tabs may still need a browser refresh or re-saving.
Existing sites receive these files on their next publication after upgrading.
