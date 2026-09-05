---
name: tr-header-footer
description: Build accessible native header and footer partials with the site logo, semantic navigation, responsive disclosure, and optional native cookie consent.
---

# Native header and footer compositions

Use block-mode partials for new work. Core 0.1.8 / capability contract 0.43.0
ships `template/site_logo`, `core/navigation`, layout primitives, and a
revision-safe partial mode operation. HTML partials remain supported for
legacy markup, but generic navigation and responsive layout no longer require
tenant HTML, CSS, or JavaScript.

## Preconditions

1. Read `get_site_capabilities`, `read_site_settings`, `list_partials`, and
   `list_block_types`.
2. Require `supports_native_navigation`, `supports_partial_mode_switching`,
   `supports_responsive_data_fields`, and
   `supports_versioned_block_type_inheritance`.
3. Read the existing header/footer before replacing anything. Work in a branch
   for redesigns and preview at desktop, 390 px, keyboard-only, and 200% zoom.

## Header tree

Stage this tree with `update_partial partial_id="header" patch={blocks:[...]}
save=true`, then call `set_partial_mode partial_id="header" to="blocks"` and
read it back. Localize both accessible labels and every link label.

```json
[
  {
    "type": "core/section",
    "data": { "width": "wide", "padding_y": "sm" },
    "children": [{
      "type": "core/container",
      "data": {
        "direction": { "mobile": "column", "tablet": "row" },
        "align_main": "space-between",
        "align_cross": "center",
        "gap": "md",
        "width": "wide",
        "padding_y": "none",
        "padding_x": "none"
      },
      "children": [
        { "type": "template/site_logo", "data": { "height": "md", "link_to_home": true } },
        {
          "type": "core/navigation",
          "data": {
            "aria_label": "Main navigation",
            "menu_label": "Menu",
            "links": [
              { "label": "Home", "href": "/" },
              { "label": "About", "href": "/about/" },
              { "label": "Contact", "href": "/contact/" }
            ]
          }
        }
      ]
    }]
  }
]
```

`core/navigation` emits a real `nav` and list in initial HTML, marks the
matching page with `aria-current="page"`, and progressively enhances to a
button-controlled mobile menu. Verify Tab and Shift-Tab order, Enter/Space,
Escape returning focus to the disclosure, visible focus, long translated
labels, and no horizontal overflow. Without JavaScript the links remain
visible and usable.

## Footer tree and consent

Use the same tree for `footer`, normally with `padding_y: "lg"`, a small site
logo, localized footer navigation, and optional contact/prose blocks. The
footer navigation gets its own accessible label; it is not the main
navigation landmark.

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

Use `update_site_settings`, then read settings back. `scripts_necessary` and
`scripts_optional` execute in visitors' browsers and must be reviewed like
other API-key-authorized script surfaces. Verify accept/necessary/reject,
optional-script gating, and keyboard focus in preview and the actual build.

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
- Mobile disclosure is keyboard accessible and does not trap focus.
- No tenant CSS is required for spacing, focus, wrapping, or the narrow layout.
- Preview and a hosted static build match before promotion.
