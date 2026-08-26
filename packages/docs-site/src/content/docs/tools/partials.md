---
title: Partials Tools
description: Tools for managing header, footer and other shared HTML fragments.
---

Partials are shared content included on every page. The two built-in partials are `header` and `footer`. You can create additional partials for reusable components (e.g. a cookie banner, a CTA section).

Like pages, partials have a `content_mode` of either `"html"` or `"blocks"`. The `replace_partial` tool below is for HTML-mode partials. For block-mode partials, the [block instance tools](/tools/blocks/) take a `target: { kind: "partial", id: "<partial_id>" }` and edit individual blocks just like they do on pages:

```
"Add a feature_grid to the header that appears on every page."
  → add_block target={kind:"partial", id:"header"} block={type:"core/feature_grid", ...}
```

## `read_partial`

Reads a partial's current HTML content.

```
Read the header partial
```

Claude always reads a partial before modifying it, so it can make targeted changes rather than replacing the whole thing.

## `replace_partial`

Replaces a partial's HTML content. Pass the new HTML directly — no wrapper object needed.

```
Add a "Blog" link to the navigation in the header.
```

Claude reads the current header, makes the targeted change, then calls `replace_partial` with the updated HTML.

## `list_partials`

Returns all partials with their IDs and a content preview.

## Navigation lives in the header partial

The site's navigation is part of the `header` partial — not in any individual page. When Claude adds a new page, it also updates the header to include a link to it.

## Typical header structure

```html
<header class="site-header">
  <div class="header-inner">
    <a href="/" class="site-logo">
      <img src="https://cdn.typeroll.com/..." alt="Acme Studio" />
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

## Custom partials

You can create any number of custom partials. Claude can embed them in page HTML or use them as standalone components:

```
Create a "cookie-banner" partial with a GDPR notice.
```

Custom partial IDs can be any lowercase string. Reference them in page HTML as static content — there is no template include syntax in HTML-mode pages; Claude copies the partial's HTML where needed.
