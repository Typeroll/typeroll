---
title: "Native header and footer compositions"
description: "Build accessible native header and footer partials with the site logo, semantic navigation, responsive disclosure, and optional native cookie consent."
editUrl: "https://github.com/typeroll/typeroll/edit/main/packages/mcp-server/skills/tr-header-footer.md"
sidebar:
  label: "Header and footer"
  order: 5
---

<!-- Generated from packages/mcp-server/skills/tr-header-footer.md by scripts/generate-skill-pages.mjs. Edit the skill, not this page. -->

This is the `tr-header-footer` recipe exactly as the Typeroll MCP server gives it to agents through `list_skills` and `read_skill`. See [Skills and recipes](../overview/) for how agents load recipes.

Use block-mode partials for new work. Prefer `get_composition_starter`
for the current native header tree: `template/site_logo`, `core/navigation_menu`
and `core/navigation_links`. Use the menu's dialog/drawer rather than an inline
mobile expansion that moves the logo. Existing `core/navigation` remains supported.

The links come from the site's **menus** (`list_menus`), not from the header.
A `core/navigation_links` block with `source: "menu"` and
`menu: "location:primary"` shows the menu in the `primary` location; the
footer shows `location:footer`. Page items link by `page_id`, so renames and
moves follow, and items with `children` get submenus. A new site has a
`primary` menu (Home, `auto_add_pages` on) and a `footer` menu. Menu-sourced
blocks need render version 15: read `read_site_settings` → `render.version`
and raise it with `tr-upgrade-rendering` if it is lower. Below 15, or for a
one-off link list, use inline `links` instead.

## Preconditions

1. Read `get_site_capabilities`, `read_site_settings`, `list_partials`, and
   `list_block_types`.
2. Require `supports_native_navigation`, `supports_partial_mode_switching`,
   `supports_responsive_data_fields`, and
   `supports_versioned_block_type_inheritance`.
3. Read the existing header/footer before replacing anything. Work in a branch
   for redesigns and preview at desktop, 390 px, keyboard-only, and 200% zoom.

## Menus first

1. `list_menus`. Make sure one menu fills `primary` and one fills `footer`;
   create missing ones with `update_menu` (`locations: ["primary"]`). Either
   edit the starter menus or create your own beside them: `update_menu
   name="Huvudmeny" locations=["primary"] take_locations=true items=[...]`
   moves the location to your menu and leaves the starter menu's items intact
   (no delete needed; the result lists `moved_locations`).
2. Build the link tree with `update_menu` (read it first and pass
   `expected_updated_at`) or `add_menu_item`: `type: "page"` with the
   `page_id` from `list_pages` for every Page, `type: "children"` with a
   label for an automatic submenu of a Page's children, `type: "url"` only for
   external addresses or anchors, and `type: "heading"` for a column title in
   a wide submenu. At most 3 levels; keep the top level to a handful of items.
3. Keep `auto_add_pages` on while the site is being built if every new
   top-level Page belongs in the header; turn it off once the menu is curated.
4. Use labels in the site's language. A Page item's label is the Page title
   unless the item sets `label`.

## Header tree

Stage this tree with `update_partial partial_id="header" patch={blocks:[...]}
save=true`, then call `set_partial_mode partial_id="header" to="blocks"` and
read it back. Localize both accessible labels and every link label.

```json
[
  {
    "type": "core/section",
    "data": {
      "width": "wide",
      "padding_y": "compact"
    },
    "children": [
      {
        "type": "core/container",
        "data": {
          "direction": "row",
          "wrap": "nowrap",
          "align_main": "space-between",
          "align_cross": "center",
          "width": "full"
        },
        "children": [
          {
            "type": "template/site_logo",
            "data": {
              "height": "md",
              "link_to_home": true
            }
          },
          {
            "type": "core/navigation_menu",
            "data": {
              "aria_label": "Main navigation",
              "menu_label": "Open menu",
              "close_label": "Close menu",
              "collapse_below": "1024"
            },
            "slots": [
              [
                {
                  "type": "core/navigation_links",
                  "data": {
                    "source": "menu",
                    "menu": "location:primary",
                    "direction": "row"
                  }
                }
              ],
              [
                {
                  "type": "core/navigation_links",
                  "data": {
                    "source": "menu",
                    "menu": "location:primary",
                    "direction": "column"
                  }
                }
              ]
            ]
          }
        ]
      }
    ]
  }
]
```

The first slot is desktop; the second is the optional mobile composition.
Both show the same `primary` menu; a separate `location:mobile` menu is only
for a site whose mobile navigation really differs. `submenus` defaults to
`auto`: a dropdown in the desktop row, an accordion in the mobile column. Set
`dropdown`, `accordion`, `expanded` or `none` to override it. Verify that
submenu buttons open with Enter/Space, close with Escape and return focus, and
that dropdown panels do not overflow the viewport at 1024 px.
The default is drawer below 1024 px and inline from 1024 px. For responsive
link fields use matching `responsive_breakpoints` (tablet 768, laptop 1024,
desktop 1280, wide 1536); do not independently hide all links at the menu boundary.
Verify 1023/1024 px, Tab/Shift-Tab, Enter/Space, Escape returning focus,
visible focus, long labels, no-JavaScript links and no horizontal overflow.

To divide the mobile panel into groups, put one `core/navigation_links` per
group in the second slot and give each a `group_label` (render version 13),
for example `"group_label": "Product"`. The label is shown above the links,
names the list for screen readers and takes the site's Eyebrow style (or
`group_label_style_id`). Do not insert Text blocks or headings as group titles
or style them with site CSS. Read `read_site_settings` → `render.version`
first; below 13, raise it with `tr-upgrade-rendering`.

A header or menu partial renders before every Page's H1, so a label in it that
is not a navigation group title, such as "Get a quote:" above contact links,
must not be a `core/heading`. Use `core/prose` with `html: "<p>Get a quote:</p>"`
and its own `font_size_px`, `font_weight` and `color` (a palette token such as
`on_secondary` on a secondary panel). `core/text` takes the same `color`.

Each entry in `links` (`core/navigation_links` and `core/navigation`) may set
`link_rel`, for example `nofollow sponsored` on an affiliate or partner link.
A `core/tabs` choice with a direct `href` accepts `link_rel` and `new_tab` too,
so a partner banner built from tabs can mark its links the same way.

## Footer tree and consent

Use an accessible footer navigation landmark and `core/navigation_links` with
`source: "menu"`, `menu: "location:footer"` and `submenus: "expanded"` (or one
block per footer column, each showing its own menu by id), not a second header
drawer. If the footer has running about text, give it a separate,
wider column beside a nested link grid. An equal four-column grid is rarely a
good fit for one dense paragraph and three short link lists. Start with
`core/columns` ratio `1-2`, put flow containers inside the slots, and tune the
gap and readable text width to the actual content. Stack on mobile. Inspect at
390, 1024, 1280 and 1536 px; do not copy one site's pixel values blindly.

Cookie consent is a site feature, not a footer widget. Configure it separately:

```json
{
  "cookie_consent": {
    "enabled": true,
    "text": "We use optional cookies. <a href=\"/privacy/\">Privacy policy</a>",
    "privacy_policy_url": "/privacy/",
    "reload_after_consent": false
  }
}
```

The heading, buttons and links follow the page language: Swedish (`sv`),
Norwegian Bokmål (`nb`, `no`), German (`de`), Dutch (`nl`), Finnish (`fi`),
French (`fr`), Polish (`pl`), Italian (`it`) and Spanish (`es`), otherwise
English. For any other language, write `text` and set `labels` (`title`,
`reject`, `necessary`, `accept_all`, `privacy_link`, `manage`,
`manage_button`) in that language. `manage` is the accessible name and
`manage_button` the visible text of the floating button that reopens the
banner. The publication's job `warnings`
list any banner wording and built-in control labels that fall back to English.

Use `update_site_settings`, then read settings back. `scripts_necessary` and
`scripts_optional` execute in visitors' browsers and must be reviewed like
other API-key-authorized script surfaces. Verify accept/necessary/reject,
optional-script gating, and keyboard focus in preview and the actual build.
The signed hosted preview runs at an opaque origin. Consent choices therefore
use in-memory state for the current preview document; they are intentionally
not persisted as portal cookies across a reload or page navigation. Accepting
all must still activate optional scripts immediately, which is enough to test
the gate without weakening the preview sandbox.

## Version and dependency rules

Child versions inherit installed, custom, and third-party block types from
their base chain. If preview reports a missing type, stop and inspect
`list_block_types` for that exact version; do not duplicate an Extension or
installation. A type missing after capability 0.43.0 is a dependency error to
report, not a reason to let the block silently disappear.

## Final checks

- Header and footer landmarks exist exactly once around their content.
- Logo is fully visible, keeps its aspect ratio, has useful alt text, and links home.
- Current-page state and localized navigation labels are correct.
- Navigation links come from menus (`source: "menu"`); every Page item uses
  `page_id`, and the publication reports no menu warnings.
- Mobile disclosure is keyboard accessible and does not trap focus.
- No tenant CSS is required for spacing, focus, wrapping, or the narrow layout.
- Preview and a hosted static build match before promotion.
