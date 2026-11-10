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
permission receives HTTP 403. A [builder](../../guides/teams-and-roles/#roles)
(through a personal connection) changes the design settings only: `colors`,
`fonts`, `typography`, `design_scales`, `responsive_breakpoints`,
`content_widths`, `header_behavior`, `motion`, `date_format`,
`image_sizes_default`, the identity (`site_name`, `tagline`, `logo`,
`favicon`, `apple_touch_icon`, `icon_192`), `custom_css`,
`render_version` and the [`handover`](#handover-object); any other field is
refused with 403. Over REST this is
`PATCH /api/v1/sites/{siteId}/settings`.

### Top-level fields

| Field                      | Type     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_name`                | string   | Display name of the site                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tagline`                  | string   | Short description, used in SEO and the footer                                                                                                                                                                                                                                                                                                                                                                                                   |
| `language`                 | string   | BCP 47 language tag: `"sv"`, `"en"`, `"de"`, etc.                                                                                                                                                                                                                                                                                                                                                                                               |
| `logo`                     | string   | CDN URL for the site logo                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `favicon`                  | string   | CDN URL for the favicon                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apple_touch_icon`         | string   | 180px Apple touch icon                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `icon_192`                 | string   | 192px application icon                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `default_seo_suffix`       | string   | Appended to page titles in `<title>`: `" — Acme Studio"`                                                                                                                                                                                                                                                                                                                                                                                        |
| `default_meta_description` | string   | Site-wide description fallback                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `default_og_image`         | string   | Fallback `og:image` URL for pages without their own                                                                                                                                                                                                                                                                                                                                                                                             |
| `twitter_handle`           | string   | X/Twitter handle for `twitter:site`; a leading `@` is removed                                                                                                                                                                                                                                                                                                                                                                                   |
| `organization`             | object   | Organization JSON-LD; see [`organization`](#organization-object)                                                                                                                                                                                                                                                                                                                                                                                |
| `staging_url`              | string   | Staging environment URL, stored for reference                                                                                                                                                                                                                                                                                                                                                                                                   |
| `trailing_slash`           | string   | `always`, `never`, or `ignore`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `iframe_allowed_hosts`     | string[] | Exact hosts allowed in embedded content                                                                                                                                                                                                                                                                                                                                                                                                         |
| `image_sizes_default`      | string   | Default responsive-image `sizes` hint                                                                                                                                                                                                                                                                                                                                                                                                           |
| `robots_txt`               | string   | Full content of robots.txt                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ai_crawler_policy`        | string   | `allow_all` (default), `no_training` or `block_all`; see [AI crawlers](#ai-crawlers)                                                                                                                                                                                                                                                                                                                                                            |
| `header_behavior`          | string   | `static` (default), `sticky` or `reveal_on_scroll_up`; see [Header while scrolling](#header-while-scrolling)                                                                                                                                                                                                                                                                                                                                    |
| `date_format`              | string   | How page and card dates read, in the page language (render version 14): `medium` (default, "12 okt. 2026"), `long`, `numeric`, `iso` or a pattern of `YYYY`, `MMMM`, `MMM`, `MM`, `M`, `DD` and `D`                                                                                                                                                                                                                                             |
| `time_zone`                | string   | Where the business is (an IANA zone such as `Europe/Oslo`): decides which day and hour it is there, for "today", "open now" and dated snippets. Opening hours are shown exactly as typed. Always set: new sites get the usual zone for their language (Swedish Europe/Stockholm, Norwegian Europe/Oslo, Danish Europe/Copenhagen, Finnish Europe/Helsinki, British English Europe/London; otherwise Europe/Stockholm); `null` resets it to that |
| `content_widths`           | object   | The shared `narrow`, `normal` and `wide` content widths in px (render version 14); defaults 672, 1040 and 1280                                                                                                                                                                                                                                                                                                                                  |
| `motion`                   | string   | `full` (default) or `reduced`: reduced turns off entrance animations, carousel autoplay, background and hero videos, moving rows, counting figures and scroll films for every visitor (render version 14)                                                                                                                                                                                                                                       |
| `sitewide_noindex`         | boolean  | Emit `noindex,nofollow` on every HTML page                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts_head`             | string   | Trusted markup/scripts inserted in `<head>`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `scripts_body_end`         | string   | Trusted markup/scripts inserted before `</body>`                                                                                                                                                                                                                                                                                                                                                                                                |
| `custom_css`               | string   | Site-wide CSS                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `render_version`           | integer  | Platform render version; see [Render versions](#render-versions)                                                                                                                                                                                                                                                                                                                                                                                |
| `handover`                 | object   | Handing the site over: checklist, start page and structure lock; see [`handover`](#handover-object)                                                                                                                                                                                                                                                                                                                                             |

An empty string clears `default_og_image`, `twitter_handle` and `staging_url`;
`null` does too. `staging_url` is stored on the site rather than in versioned
settings, so a branch cannot reroute it: it is written the same way whichever
`version` you pass, and trailing slashes are dropped.

### Header while scrolling

`header_behavior` decides what the site header does while a visitor scrolls.
It applies to the header partial on every page, also in previews.

| Value                 | Behaviour                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `static` (default)    | The header scrolls away with the page. Nothing is added to the published pages.                                                                  |
| `sticky`              | The header stays at the top of the window.                                                                                                       |
| `reveal_on_scroll_up` | The header hides while the visitor scrolls down and returns on the first scroll up. Keyboard focus in the header and an open menu keep it shown. |

Once the page has scrolled past the header, a returning `reveal_on_scroll_up`
header is compact: it carries `data-header-compact`, and its Navigation menu
opens from the menu button at every width, not only below the menu's collapse
width. Style the compact state in custom CSS or a Style, for example to hide a
secondary link row: `header[data-header-compact] .my-header-links { display: none; }`.
Visitors who prefer reduced motion get no slide animation.

### AI crawlers

`ai_crawler_policy` states the site's preference for AI crawlers. It uses the
[Content Signals](https://contentsignals.org) vocabulary that Cloudflare uses
for its managed robots.txt, so the site and a Cloudflare zone describe the same
choices in the same terms.

| Value         | robots.txt and `Content-Signal` header  | Disallowed user agents                                                                                                                                                                                 |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allow_all`   | Nothing is added (the default)          | None                                                                                                                                                                                                   |
| `no_training` | `search=yes, ai-input=yes, ai-train=no` | Training-only crawlers: GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Bytespider, meta-externalagent, cohere-training-data-crawler, AI2Bot                                             |
| `block_all`   | `search=yes, ai-input=no, ai-train=no`  | The training crawlers, plus AI search and user agents: OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, DuckAssistBot, MistralAI-User, meta-externalfetcher |

- Googlebot, Bingbot and Applebot are never listed. They also index the site
  for ordinary search, and blocking them removes it from search results.
- The signal goes into the `User-agent: *` group of `/robots.txt`, after your
  own `robots_txt` text is applied. A group you wrote for an agent yourself
  wins: the policy does not add a second group for it.
- Published Cloudflare Pages sites also send a `Content-Signal` response header
  with the same value. Hosts that ignore the `_headers` file, such as a
  self-hosted export served elsewhere, get the robots.txt lines only.
- `null` resets the setting to `allow_all`. An Extension credential cannot
  change it.

robots.txt is a request that well-behaved crawlers follow, not access control.
A Cloudflare zone can also have its own AI bot policy, which Cloudflare enforces
at the edge regardless of robots.txt. If the zone blocks training crawlers,
Cloudflare also blocks crawlers that do both search and training, such as
Googlebot, which can remove the site from search. Keep the zone policy and this
setting consistent, and turn off Cloudflare's managed robots.txt if you want
the site's file to be the only one. The change applies when the site is
published again.

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

### `handover` object

`handover` prepares the site for the people who edit it: a checklist, the page
they start on and an optional structure lock. The portal sets it under
**Settings → Access & AI → Manage handover**; see
[Hand a site over](../../guides/handover/).

```json
{
  "handover": {
    "lock_structure": true,
    "start_page": "home",
    "checklist": [
      {
        "id": "photos",
        "label": "Replace the sample photos",
        "href": "/app/sites/bistro/media"
      },
      { "id": "domain", "label": "Connect the domain", "done": true }
    ],
    "handed_over_at": "2026-11-07T12:00:00Z"
  }
}
```

| Field            | Type    | Description                                                                                                                                                 |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock_structure` | boolean | People without design rights change text and images but not the blocks, their order or types, page templates or pages                                       |
| `start_page`     | string  | Id of a page of the site that the start view opens first                                                                                                    |
| `checklist`      | array   | Up to 40 items: `id` (lowercase letters, digits, `-` and `_`), `label` (up to 200 characters), optional `done` and `href` (a portal path starting with `/`) |
| `handed_over_at` | string  | ISO date when the site was handed over; absent while it is being built                                                                                      |

The object is **replaced as a whole**, not merged like `fonts`: send the
complete checklist each time. `null` removes the handover, which also unlocks
the structure. An unknown key, a bad item or a `start_page` that is not a page
of the site answers 400 with the problems in `details.errors`.

Writing it needs design rights: an administrator, or a builder of the site's
Organization. Editors and clients with a shared site are refused with 403.
An app installation writes it only with the `site:handover` scope, which reads
the settings (`GET`) and writes the `handover` key and nothing else; any other
key in the same request is refused with 403. `content:write` alone cannot set
it.

While `lock_structure` is on, every write that adds, removes, moves,
duplicates or retypes blocks, applies a page template, or creates or deletes
pages answers `403` with `{ "error": "The site's structure is locked; you can
edit text and images.", "code": "structure_locked" }` for anyone without
design rights. Content edits save as usual.

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

| Field       | Default   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heading`   | `"Inter"` | Heading font family: a catalog (Google Fonts) family, a family in the site's [Fonts library](../fonts/#the-fonts-library) or a font service, or `system`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `body`      | `"Inter"` | Body font family                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mono`      | unset     | Code and preformatted text; unset uses the system monospace stack. An empty value or `null` clears it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `display`   | unset     | Large headings and heroes (render version 15); unset uses the heading family. `null` clears it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `accent`    | unset     | Eyebrows and quotes (render version 15); unset uses the body family. `null` clears it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `load`      | unset     | Weights and italics to load per role beyond those the site uses (render version 15; from 17 the site's CSS counts as use too), such as `{ "body": { "weights": [300], "italic": [400] } }`. See [weights in use](../fonts/#weights-in-use). `null` clears it                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `services`  | unset     | Up to four font services loaded from their CDN: Adobe Fonts kits and Bunny Fonts or Fontshare stylesheets, each with the `families` it defines. See [Adobe Fonts, Bunny Fonts and Fontshare](../fonts/#adobe-fonts-bunny-fonts-and-fontshare). `null` clears it                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `size_base` | `16`      | Base font size in px, from 12 to 24                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `smoothing` | unset     | `auto` (browser default) or `antialiased`. Unset is `auto` from render version 6 and `antialiased` before it. `antialiased` draws thinner text on macOS and can suit light text on a dark background; `null` clears it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `delivery`  | unset     | `self_hosted` (unset) or `google`. Self-hosted: Typeroll copies the theme's font files from Google Fonts while preparing each publication and publishes them on the site's own origin, so a visitor's browser never contacts Google, including before any consent choice, and no build engine needs network access for them. A failed copy is retried; if Google stays unreachable, the previous publication's identical fonts are reused, and otherwise the publication stops with `theme_fonts_unavailable` before anything changes. `google` loads the fonts from the Google Fonts CDN, which sends each visitor's IP address to Google. Editor previews still load fonts from Google. `null` clears it. |

Styles and blocks choose a role, never a family. Find families with
[`search_fonts`](../fonts/#search_fonts) and set the roles with
[`set_site_fonts`](../fonts/#set_site_fonts) or this `fonts` object; the
response warns about a family that is not in the catalog, the Fonts library
or a font service. `font_plan` cannot be set: a publication derives it.

Use exact Google Fonts family names, such as `Plus Jakarta Sans`. A self-hosted
publication serves `/_typeroll/fonts/fonts.css` and the font files under
`/_typeroll/fonts/`. A family Google does not serve is skipped without an error,
and the browser falls back to the next font in the stack; `system` and local-only
families such as Arial copy nothing. To verify, open `fonts.css` on the published
site: it should contain `@font-face` rules for each chosen family, and every
font file it names should return 200.

### `typography` and `design_scales`

Available in Core 0.2.114 / MCP 0.45.85. Render version 10 provides fluid defaults.
In **Site settings → Design**, preview your saved role styles and unsaved scale
controls at 375, 768 and 1280px before saving.

| Setting                    | Default | Range / purpose                                 |
| -------------------------- | ------- | ----------------------------------------------- |
| `typography.ratio_mobile`  | `1.2`   | 1.1–1.5; narrow-screen heading scale            |
| `typography.ratio_desktop` | `1.25`  | 1.1–1.5; wide-screen heading scale              |
| `typography.rhythm`        | `1`     | 0.5–2; spacing and proportional heading margins |
| `typography.line_length`   | `65`    | 40–90 characters, or `"none"`; prose measure    |

`typography.line_length: "none"` removes the reading measure: prose fills its
column (`--measure-prose` is `100%`), for templates that set their own text
columns.

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
page language (`Page.language`, otherwise the site `language`) in the 50
languages listed under [built-in interface text](../blocks/library/#built-in-interface-text),
for example French, Japanese, Arabic and Chinese, otherwise English. The default `text`
follows the same rule. A publication for another language reports the wording
that falls back to English in its job `warnings`. Set `labels` only to replace that wording, for example for another
language. Its keys are `title`, `reject`, `necessary`, `accept_all`,
`privacy_link`, `manage` (the accessible name of the floating button that
reopens the banner) and `manage_button` (its visible text, "Cookies" by
default). Values are plain text of at most 120 characters,
and blank values use the built-in wording. `labels` is replaced as a whole.

The object is shallow-merged, so omitted fields keep their saved values. In a
signed hosted preview the banner and optional-script gate work, but the frame
has an intentionally opaque origin: the choice is held in memory for the
current preview document and resets on reload/navigation. A published build
uses the normal `tr_consent` cookie.

#### Styling the cookie banner

The banner's parts carry classes for site CSS: `.tr-consent` (the overlay),
`.tr-consent__panel`, `.tr-consent__title`, `.tr-consent__body`,
`.tr-consent__link`, `.tr-consent__actions`, `.tr-consent__btn` with
`--ghost` and `--primary`, and `.tr-consent__manage` (the floating button that
reopens it). It takes `--color-primary`, `--font-body` and `--font-heading`
from the theme. From render version 16 its styles sit in a cascade layer, so a
class rule such as `.tr-consent__title { font-weight: 700 }` changes it
without `!important`. In version 16 a bare element rule in site CSS (`h2`, `p`,
`button`) also reaches the banner; from version 17 such rules no longer do,
and only rules that name the banner's classes restyle it.

#### Embeds behind the banner

A `core/embed` block with `consent: "optional"` waits for the same answer as
`scripts_optional`: its HTML and JavaScript load only after "Accept all", and
a note with a button that reopens the banner shows until then. The button uses
the `manage` label. See
[embeds that wait for cookie consent](../blocks/parts/#embeds-that-wait-for-cookie-consent).

### `language_sections` array

One site can serve several languages from language folders. Each section names
a language and its home page (its path prefix), and can override the tagline,
the fallback description and the cookie banner's `text`, `labels` and
`privacy_policy_url` for pages in that language:

```json
{
  "language_sections": [
    {
      "language": "sv-SE",
      "home_path": "/sv/",
      "cookie_consent": { "privacy_policy_url": "/sv/cookies/" }
    }
  ]
}
```

`language` is a BCP 47 tag other than the site `language`; `home_path` starts
and ends with `/` and is not `/`. Pages belong to a section through
`Page.language`. The section also gives them a home crumb linking to
`home_path` and a 404 page at `<home_path>404.html`. The list is replaced as a
whole, and `null` clears it. See
[Several languages on one site](../../guides/multilingual-sites/).

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

Bootstraps a whole new site that publishes through the Organization's
[publishing setup](../../guides/customer-publishing/). Over REST this is `POST /api/v1/sites`. It accepts these fields and
answers `400` naming any other field:

| Field      | Required | Meaning                                                                                                                                                                                                                                                                                                                 |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | yes      | Display name.                                                                                                                                                                                                                                                                                                           |
| `id`       | no       | Site id: 3–48 lowercase letters, digits and `-`, such as `lakeside-cafe`. Used exactly; `409` with code `site_id_taken` when the Organization already has it. Without it, the id is the kebab-case name, with a random suffix when that is taken.                                                                       |
| `domain`   | no       | Real hostname, such as `lakesidecafe.se`. Saved as the future website host in Publishing domains; it is not live until a verified publication switches traffic.                                                                                                                                                         |
| `language` | no       | Content language as a BCP 47 tag, such as `sv` or `nl-BE`, checked like `update_site`'s. Sets `<html lang>` from the first build. Default: the template's language, else `en`.                                                                                                                                          |
| `from`     | no       | Start from a template instead of the blank starter: `{ "site_id": "…", "version": "…" }`, `{ "collection_entry": "…" }` or `{ "package": { "data_base64": "…" } }` / `{ "package": { "source_url": "https://…" } }`. See [Start a site from a template or another site](#start-a-site-from-a-template-or-another-site). |
| `options`  | no       | With `from`: `{ "design": "full" \| "styles" \| "content", "fonts": false, "font_licence_confirmed": true }`. `design` defaults to `full`.                                                                                                                                                                              |

```
Create a new site called "Lakeside Cafe" in Swedish for lakesidecafe.se.
```

The answer is `201` with the new site's `id`, `name`, `domain`, `language` and
`urls`.

Requires an **org-scoped** API key. A site-scoped key can only reach the one site
it was issued for, which is the point of the distinction — see
[Install the MCP Server](../../getting-started/mcp-server/).

To start from a WordPress migration or an AI site plan instead of a blank Site,
use `create_site_and_migrate` or `create_site_and_plan` — two more options
on the portal's **New site** page. See
[Organization, access and workflow tools](../organization/#create-a-site-with-its-first-workflow).

### Start a site from a template or another site

A new Site can start from a whole-site [package](../packages/) instead of the
blank starter: a `.typeroll` file, a `package` entry of the
[organization collection](../collection/), or another Site of the same
Organization. In the portal, use **Start from a template or another site** on
the **New site** page. With MCP, pass one of `from_site_id` (with an optional
`from_site_version`), `from_collection_entry`, `from_package_base64` or
`from_package_url` to `create_site`:

```
Create a new site "Harbor Bakery" as a copy of the site corner-bakery.
```

A package belongs to no Organization, so a template you bought works like
your own. Another Site is copied as a whole-site package built for the copy:
its media files are read and stored again in the new Site's own Media
library, so the two Sites never share files.

**Copied:**

- Pages: block pages, HTML pages and the records of every Content type, with
  their ids, addresses, status, fields and SEO settings, and the Content types.
- The header, the footer and the other global blocks; menus with their items.
- Styles (created with their ids, never mapped to "nearest" ones), block
  types, block templates and Page templates.
- Site fields with their values.
- Media, into the new Site's library. Images a template marks as demo content
  stay marked; the Site's [readiness report](../../guides/launch-checklist/)
  lists them for replacement before publication.
- With `design` `full` (the default for a new Site): the element styles,
  colours, typography, scales, content widths and font roles. Uploaded font
  files only with `font_licence_confirmed: true`, the creator's confirmation
  that the font licence allows use on the new Site; `fonts: false` leaves them
  out. `styles` takes the template's styles in the default look; `content`
  only the content and the styles it uses.
- From another Site, also: its settings that are content (tagline, logo,
  icons, contact and social details, SEO defaults, language sections, Site CSS
  and display settings), forms without their actions, and live snippets (the
  first publication writes their live files). The time zone and render
  version follow the source.

**Never copied:** domains and domain declarations, publishing, hosting and
build settings, API keys, shares, app installations and their settings, form
actions (email notifications, webhooks, app endpoints) and other credentials,
integrations, custom and tracking scripts (also those of the cookie banner),
font service kits, the custom `robots.txt`, sitewide noindex and nofollow,
external routes, redirects, deploy history and revisions. Each app the source
Site uses is named in `started_from.warnings`, to install on the new Site.

The new Site's language is the request's `language`, else the template's.
A home page, header, footer and the primary and footer menus are created
only where the template has none; `started_from.defaults` lists them.

Rules:

- `from.site_id` must be a Site of your own Organization that you may read; a
  Site shared in from another Organization is refused with `404`
  `site_source_not_found`, like a Site that does not exist.
- `from.collection_entry` follows the collection rule: an owner,
  administrator or builder of the Organization. Only `package` entries (whole
  Sites) qualify; others answer `400` `package_not_a_site`, as does a package
  of templates rather than a whole Site.
- A package whose signature does not match its contents is refused with
  `422` `package_signature_invalid`. Font files without the licence
  confirmation answer `400` `font_licence_required` before anything is created.
- If the import fails after the Site was reserved, the half-created Site is
  removed again and the error says so (`site_create_failed`, or the import's
  own code, with `details.site_removed`).

The answer adds `started_from`: `kind` (`site`, `collection_entry` or
`package`), `source`, the import `report` (what was created and reused),
`defaults` and `warnings`. Show the warnings to the person who asked.

## `update_site`

Changes a site's name, slug, domain, language or `ai_scripts_enabled`. Over REST
this is `PATCH /api/v1/sites/{siteId}`. Changing `slug` or `domain` requires
admin permission on the site (`403` otherwise): the domain becomes the canonical
URL of every build. Name and language need write permission.

The slug is a URL-stable identifier, uniqueness-checked within the
Organization. Changing it changes no hosting or DNS: website and media hosts
are managed in [Website and media domains](../../publishing/domains/).

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

| Version | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Baseline: block markup and platform CSS as in Core 0.2.56.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2       | Heading eyebrow and subtitle are grouped with the heading (`<hgroup>`), take named styles and are never faded. A custom class on a heading or button block lands on the `<h2>` or link itself, so `.my-class .block-heading-text` becomes `.my-class`. Text on primary-coloured buttons is black or white, whichever reads better.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3       | Theme tokens that blocks reference (`--color-bg`, `--color-bg-subtle`, `--color-border`, `--color-secondary-fg`) come from the site palette. Subtle panels such as table headers, code and tabs use the Surface colour instead of a fixed light grey, borders stay visible on dark backgrounds, and text on secondary-coloured buttons is black or white, whichever reads better.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4       | Lists in core blocks render: accordion items (with **Default open**), pricing plan features and team member social links. An icon without a link no longer sits in an empty link, a team member card is a link only when it has one, and a container set to link without an address renders as a plain container, so icons and cards work inside linked items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5       | Multi-step forms: the button reads "Continue" ("Fortsätt" on Swedish sites) on every step but the last, which keeps the form's submit text; a "Back" button returns to the previous step with the answers kept; a step that starts with a form heading no longer also shows its step title. See [Multi-step forms](../forms/#multi-step-forms).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6       | Text uses the browser's default font smoothing and text rendering. Earlier versions set `-webkit-font-smoothing: antialiased` and `text-rendering: optimizeLegibility` on every page, which on macOS draws dark text on a light background thinner and lighter than other sites at the same weight. Choose **Typography → Font smoothing → Antialiased** (`fonts.smoothing`) to keep the thinner rendering, for example for light text on a dark background; the choice applies on every version.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7       | Video, ratings and carousels: `core/video` embeds YouTube (no-cookie) and Vimeo addresses and plays video files with poster, autoplay, loop, muted, controls and lazy loading; a hero plays a video file as a muted background with a pause button; a testimonial rating shows as stars; carousels get previous/next buttons, dots and optional autoplay with pause. Nothing moves for visitors who prefer reduced motion. See [Blocks](../blocks/library/#video-hero-video-and-ratings-render-version-7).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8       | Text on primary, secondary and accent (buttons, badges, tabs, call-to-action sections) is black or white by APCA instead of the WCAG 2 ratio. On mid-dark saturated colours such as teal, green or medium blue, near-black text becomes white, which reads better: white on `#00a19c` is APCA Lc 63.9 against Lc 44 for `#111827`. A text colour chosen in `colors.on_*` applies on every version and does not change. See [Text on theme colours](#text-on-theme-colours).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9       | A container with a shadow (`shadow: "subtle"` or `"header"`) is raised above the blocks after it (`position: relative; z-index: 10`), so the next block's background or image no longer covers the shadow, and menus that open from a shadowed header land above the next block. A sticky container keeps z-index 100. The container becomes the containing block of its absolutely positioned content. The header shadow is `0 2px 6px` instead of `0 2px 5px`. See [Blocks](../blocks/).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10      | Fluid typography and spacing scales, proportional editorial heading margins, no role margin on component titles or opening headings, and a configurable prose measure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11      | Editorial headings keep their rhythm inside columns and grids; navigation link groups keep 44px touch targets without an extra vertical gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12      | A container with width narrow, normal or wide inside a container that is a column at every breakpoint fills it up to its maximum width and stays centered, instead of shrinking to its content (an archive with one card is as wide as one with many). Column containers carry `data-column-only="true"`; rows are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 13      | A container that is a column at every breakpoint keeps its children on one line, so a long word, address or inline code no longer widens every child and makes phones scroll sideways. Text paragraphs, list items and headings and Heading blocks break such words; code blocks scroll. `core/navigation_links` takes an optional `group_label`. See [Blocks](../blocks/layouts/#long-words-on-small-screens-render-version-13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 14      | Platform CSS in cascade layers, so site CSS overrides it without `!important`; responsive defaults for every block (smaller phone headings, shared narrow, normal and wide content widths so blocks of one width line up, components that adapt to narrow cells); built-in labels and dates in the page language; and new options: entrance animation (`motion`), background images and videos behind sections, containers and calls to action, text over images (darkening, plates including glass, a section text position per screen size), a gallery lightbox, a moving logo row and video in several sizes and formats. Site settings `date_format`, `content_widths` and `motion`. See [Blocks](../blocks/library/#motion-background-media-and-story-blocks-render-version-14).                                                                                                                                                                      |
| 15      | Menus with submenus and fonts in use. `core/navigation_links` can show a site menu (`source: "menu"`, `menu: "location:primary"` or a menu id); page items follow renames, and items with children get a dropdown or accordion submenu (`submenus`). See [Menus](../menus/#showing-a-menu-in-the-header-or-footer). Fonts load only the weights and italics the site uses (plus `fonts.load`) instead of a fixed 400–700; a variable family loads as one file for the range in use, and the body font is preloaded. A self-hosted or uploaded family gets a metric-matched fallback face, so text keeps its place while the font loads. Two more font roles, `display` (large headings and heroes) and `accent` (eyebrows and quotes). See [Fonts](../fonts/#weights-in-use). Authored text can use `{{site.name}}` and `{{site.fields.<name>}}`, so a template names the site it is inserted into; see [Packages](../packages/#text-that-names-the-site). |
| 16      | Clearer groups and compact controls: plain site CSS changes every platform value without `!important` (block settings reach CSS as data attributes, and only custom properties are written inline), platform media queries follow the site's responsive widths, and many blocks gain alignment, size, colour and layout settings. A form's Back and Submit buttons sit together in a `.form-actions` row, so CSS that placed the button in the form grid targets `form > .form-actions`. The cookie banner's styles sit in a cascade layer. The full list is in `read_site_settings` → `render.upgrades`.                                                                                                                                                                                                                                                                                                                                                  |
| 17      | Fonts from site CSS and a steady cookie banner. Weights and italics written in CSS count as in use (see [weights in use](../fonts/#weights-in-use)), so `fonts.load` is only needed for weights the planner cannot see. Bare element rules in site CSS (`h2`, `p`, `a`, `button`) no longer restyle the cookie banner, and its buttons use the body font at weight 600. See [Styling the banner](#styling-the-cookie-banner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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

`icon_192` supplies the 192 and 512 pixel images in `/site.webmanifest`. If it
is absent, Typeroll generates them from the favicon. The home screen icon for
iPhone and iPad (`/apple-touch-icon.png`, 180 pixels) is generated too: from
`apple_touch_icon` when set, otherwise from the favicon. iOS does not allow
transparency there, so a transparent motif is placed with a margin on the
site's background colour, and an opaque image fills the icon. A site without
any icon setting receives a small transparent fallback favicon, so
`/favicon.ico` does not return an HTML error page, and no home screen icon.

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
