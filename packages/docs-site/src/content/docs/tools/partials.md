---
title: Partials Tools
description: Tools for managing header, footer and other shared HTML fragments.
---

These tools wrap `/api/v1/sites/{siteId}/partials`, with `/{partialId}`, `/{partialId}/mode` and `/{partialId}/usage` beneath it.
The same API key works over REST; see
[calling the same operations over REST](../overview/#calling-the-same-operations-over-rest).

The two built-in partials, `header` and `footer`, are shared content included on every page. Additional partials are global blocks and appear only where referenced (for example a contact strip or CTA section). The portal calls these **Global blocks**; the API retains the technical name `partials`.

Like pages, partials have a `content_mode` of either `"html"` or `"blocks"`. The `replace_partial` tool below is for HTML-mode partials. For block-mode partials, the [block instance tools](../blocks/) take a `target: { kind: "partial", id: "<partial_id>" }` and edit individual blocks just like they do on pages:

```
"Add a navigation menu to the header."
  → add_block target={kind:"partial", id:"header"} block={type:"core/navigation_menu", ...}
```

A new site's header and footer start in HTML mode. A `PATCH` or `PUT` that sends
`blocks` to an HTML-mode partial, or `html_content` to a block-mode one, stores
the content but does not render it. The response then carries a warning
`{ code: "content_mode_mismatch", content_mode, ignored_field }` naming the
`/mode` endpoint. Switch with `POST /partials/{partialId}/mode` (`set_partial_mode`)
first; the switch keeps both versions. Pages answer the same way.

## `read_partial`

Reads a partial's current HTML content.

```
Read the header global block
```

The AI agent always reads a partial before modifying it, so it can make targeted changes rather than replacing the whole thing.

## `replace_partial`

Replaces a partial's HTML content. Pass the new HTML directly — no wrapper object needed.

```
Add a "Blog" link to the navigation in the header.
```

The AI agent reads the current header, makes the targeted change, then calls `replace_partial` with the updated HTML.

## `list_partials`

Returns all partials with their IDs and a content preview.

## Navigation lives in the header partial

The site's navigation is part of the `header` partial — not in any individual page. Ask the agent to add a navigation link when the Page belongs in the menu. Creating a Page does not itself require a new header link.

## Typical header structure

```html
<header class="site-header">
  <div class="header-inner">
    <a href="/" class="site-logo">
      <img src="https://media.example.com/logo.svg" alt="Acme Studio" />
    </a>
    <nav class="site-nav">
      <a href="/">Start</a>
      <a href="/om-oss">Om oss</a>
      <a href="/tjanster">Tjänster</a>
      <a href="/kontakt">Kontakt</a>
    </nav>
  </div>
</header>

<style>
  .site-header { ... }
</style>
```

## Custom partials (global blocks)

Custom partials are global blocks: one shared source shown wherever a page
places it. Block-mode pages reference one with a `core/global_block` block;
HTML-mode pages embed it with `<x-include name="cookie-banner" />`. Editing it
changes every page that uses it.

```
Create a "cookie-banner" global block with a GDPR notice.
```

See [Global blocks and block templates](../reusable-blocks/) for making a page
section global, detaching a copy, and block templates that are copied into a
page instead.

## History

Every save of a partial keeps the previous saved state. `list_partial_revisions`,
`read_partial_revision` and `restore_partial_revision` list, read and restore
them (`/api/v1/sites/{siteId}/partials/{partialId}/revisions`). A restore puts
the earlier name and content back as a draft, or saves it with `save: true`.
See [History and restore](../drafts-and-saving/#history-and-restore).
