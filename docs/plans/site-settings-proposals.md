# Per-site settings: added and proposed

Status: 2026-11-07. Settings a site should be able to change without CSS of
its own, collected while fixing the demo-site findings. The rule: a default
that suits most sites, one simple setting for the common alternative, and no
setting where a block field or a site style already does the job.

## Added at render version 14

| Setting | Values | Where it applies |
|---|---|---|
| `date_format` | `medium` (default, "12 okt. 2026"), `long` ("12 oktober 2026"), `numeric`, `iso`, or a pattern of YYYY, MMMM, MMM, MM, M, DD and D | Page date blocks left at their default format, and card dates, in the page language |
| `content_widths` | `{ narrow, normal, wide }` in px, defaults 672, 1040 and 1280 | The shared widths sections, containers, heroes, feature rows and calls to action use |

Both are in the portal (Settings → Design), the settings API and the MCP
`update_site_settings` tool, and travel with the publication.

## Proposed

Ordered by value for a typical site. Size is a rough guide: small (a token
and a field), medium (several blocks or a new mechanism), large (an audit
of every block).

1. **Colour scheme (dark mode)** — large.
   `color_scheme: light | dark | auto` and a dark palette derived from the
   site colours, which the site can adjust (`colors_dark`). Needs:
   - an audit of hard-coded colours in block CSS (several use `#fff`,
     `#111` or `white` as fallbacks);
   - logos and images that work on both backgrounds (an optional dark logo);
   - a contrast check of the derived palette, like the on-colour checks;
   - `auto` follows the visitor's system setting; a visitor toggle is a
     separate decision.
2. **Interface wording** — medium.
   `ui_labels: { learn_more: "Läs mer om oss", … }` overrides a built-in
   label (Learn more, On this page, Menu, Previous, Next, Download PDF,
   Continue and the others) for the whole site, instead of per block. Also
   covers languages without a built-in translation.
3. **Button shape** — small.
   `button_shape: pill | rounded | square`. Version 14 gives hero, feature
   row and call-to-action buttons pill ends; other buttons have their own
   radius. One token would make them consistent.
4. **Corner radius** — small.
   `radius: none | small | medium | large` for cards, images and panels
   (today each block has its own radius).
5. **Time and time zone** — small.
   `time_zone` (IANA) and `time_format: 24h | 12h` for events and dates
   with a time. Only needed once a block shows times.
6. **Motion** — small.
   `motion: full | reduced` turns off carousel autoplay and transitions for
   every visitor, not only those who ask for reduced motion.
7. **Link style in text** — small.
   `text_links: underline | hover` for links inside running text.

Not proposed as settings: header and footer link layout (starter data and
the navigation block's own fields), section spacing (`design_scales`), and
phone type size (`typography.ratio_mobile`).
