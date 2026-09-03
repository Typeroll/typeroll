---
name: tr-collection-template
description: Use when building a rich per-item detail page for a Typeroll collection — podcast episodes with audio players and chapter timestamps, case studies with guest cards and metric tiles, products with image galleries and spec tables, anything where the detail template would normally want loops or nested data. Covers the "pre-render into a field" pattern that gets you past the template's no-loops-no-conditionals limit.
---

# Rich detail templates for collections

Prefer `item_template_blocks` when the design fits the block system. It can
include `template/item_navigation`, whose previous/next URLs and titles are
derived from the collection's `sort_field` and `sort_dir`; do not precompute
four navigation fields per item. Use the HTML patterns below when the detail
page genuinely needs richer loops or markup than the block schema provides.

`item_template_html` uses lightweight Mustache substitution:

- `{{field}}` — HTML-escaped value
- `{{{field}}}` — raw value (for richtext / pre-rendered HTML)
- `{{#field}}…{{/field}}` — conditional, render block when field is truthy
- `{{url}}` — only meaningful in `regenerate_collection_listing`'s `item_template` (resolves through `route_template`)

**No loops, no nested field access, no arithmetic.** `{{chapters[0].title}}` doesn't work. `{{#chapters}}{{title}}{{/chapters}}` doesn't either — the section syntax is truthiness-only, not iteration.

The pattern that gets you everywhere: **pre-render the HTML into a single string field on the item itself.** The agent (you) does the loop in JavaScript/Python during data prep, then writes the resulting HTML into a richtext field like `chapters_html` or `gallery_html`. The template renders it raw with `{{{chapters_html}}}`.

This skill catalogues the patterns we hit most often, with copy-paste recipes.

## Pattern 1 — Audio player + chapter list (podcast episodes)

**Data shape going in:**

```json
{
  "title": "Avsnitt 17 — Designsystem på riktigt",
  "slug": "17-designsystem-pa-riktigt",
  "date": "2025-05-15",
  "audio_url": "https://cdn.example.com/avsnitt-17.mp3",
  "duration_min": 42,
  "chapters": [
    { "time_seconds": 0,    "title": "Intro" },
    { "time_seconds": 132,  "title": "Vad är ett designsystem?" },
    { "time_seconds": 845,  "title": "Tokens vs. komponenter" },
    { "time_seconds": 1820, "title": "Vanliga fällor" }
  ]
}
```

**Pre-render `chapters_html` before calling `create_collection_item`:**

```js
const formatTime = (s) =>
  s < 3600
    ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
    : `${Math.floor(s/3600)}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

const chaptersHtml = `
<ol class="chapters">
  ${item.chapters.map(c => `
    <li>
      <button type="button" data-jump-to="${c.time_seconds}">
        <span class="chapters__time">${formatTime(c.time_seconds)}</span>
        <span class="chapters__title">${escapeHtml(c.title)}</span>
      </button>
    </li>
  `).join('')}
</ol>`;
```

**Schema (note `chapters_html: richtext` — it carries HTML):**

```
create_collection {
  "name": "avsnitt",
  "label_singular": "Avsnitt",
  "label_plural": "Avsnitt",
  "slug_field": "slug",
  "sort_field": "date",
  "sort_dir": "desc",
  "route_template": "/podd/{slug}",
  "fields": [
    {"name":"title",         "type":"text",     "required":true},
    {"name":"slug",          "type":"text",     "required":true},
    {"name":"date",          "type":"date",     "required":true},
    {"name":"audio_url",     "type":"text",     "required":true},
    {"name":"duration_min",  "type":"number"},
    {"name":"excerpt",       "type":"textarea"},
    {"name":"body",          "type":"richtext"},
    {"name":"chapters_html", "type":"richtext", "label":"Kapitellista (genereras)"}
  ],
  "item_template_html": "<article class=\"episode\">\n  <header class=\"episode__hero\">\n    <p class=\"episode__date\">{{date}} · {{duration_min}} min</p>\n    <h1>{{title}}</h1>\n    <p class=\"episode__excerpt\">{{excerpt}}</p>\n  </header>\n  <div class=\"episode__player\">\n    <audio controls preload=\"metadata\" src=\"{{audio_url}}\"></audio>\n  </div>\n  {{#chapters_html}}<section class=\"episode__chapters\"><h2>Kapitel</h2>{{{chapters_html}}}</section>{{/chapters_html}}\n  <section class=\"episode__notes\">{{{body}}}</section>\n  <script>\n    document.querySelectorAll('[data-jump-to]').forEach(b => {\n      b.addEventListener('click', () => {\n        const a = document.querySelector('audio');\n        if (a) { a.currentTime = Number(b.dataset.jumpTo); a.play(); }\n      });\n    });\n  </script>\n  <style>\n    .episode{max-width:42rem;margin:3rem auto;padding:0 1rem}\n    .episode__hero{background:linear-gradient(135deg,var(--color-primary),var(--color-accent));color:#fff;padding:3rem 2rem;border-radius:1rem;margin-bottom:2rem}\n    .episode__date{opacity:0.85;font-size:0.85rem}\n    .episode__hero h1{font-family:var(--font-heading);font-size:2rem;margin:0.5rem 0}\n    .episode__player audio{width:100%}\n    .chapters{list-style:none;padding:0;margin:1.5rem 0}\n    .chapters li{margin:0.25rem 0}\n    .chapters button{display:flex;gap:1rem;width:100%;background:transparent;border:0;padding:0.5rem 0.75rem;cursor:pointer;text-align:left;border-radius:0.375rem;font:inherit;color:inherit}\n    .chapters button:hover{background:var(--color-surface)}\n    .chapters__time{font-variant-numeric:tabular-nums;color:var(--color-text-light);min-width:4ch}\n  </style>\n</article>"
}
```

**Create the item with both raw chapters AND the pre-rendered HTML:**

```
create_collection_item collection="avsnitt" status="published" fields={
  "title":         "Avsnitt 17 — Designsystem på riktigt",
  "slug":          "17-designsystem-pa-riktigt",
  "date":          "2025-05-15",
  "audio_url":     "https://cdn.example.com/avsnitt-17.mp3",
  "duration_min":  42,
  "excerpt":       "Vi pratar med...",
  "body":          "<p>...</p>",
  "chapters_html": "<ol class=\"chapters\">...</ol>"
}
```

The raw `chapters` array doesn't need to be stored unless you have a use for it (e.g. regenerating the HTML later from a structured source). If you do want it for round-trip editing, add a `chapters_json: textarea` field and stringify the array into it.

## Pattern 2 — Guest card with nested fields

Each episode features a guest with a name, role, photo, and external links. Mustache can't reach into nested objects, so flatten OR pre-render.

**Option A: Flatten into prefixed fields (preferable when there's ≤1 guest):**

```
fields: [
  ...,
  {"name":"guest_name",  "type":"text"},
  {"name":"guest_role",  "type":"text"},
  {"name":"guest_photo", "type":"image"},
  {"name":"guest_bio",   "type":"textarea"},
  {"name":"guest_linkedin", "type":"text"},
  {"name":"guest_website",  "type":"text"}
]
```

In the template:

```html
{{#guest_name}}
<aside class="guest">
  {{#guest_photo}}<img src="{{guest_photo}}" alt="{{guest_name}}">{{/guest_photo}}
  <div>
    <h3>{{guest_name}}</h3>
    <p class="guest__role">{{guest_role}}</p>
    <p>{{guest_bio}}</p>
    <p class="guest__links">
      {{#guest_linkedin}}<a href="{{guest_linkedin}}">LinkedIn</a>{{/guest_linkedin}}
      {{#guest_website}}<a href="{{guest_website}}">Webbplats</a>{{/guest_website}}
    </p>
  </div>
</aside>
{{/guest_name}}
```

**Option B: Pre-render `guest_html` (when there are multiple guests or arbitrary depth):**

```js
const guestHtml = item.guests.map(g => `
  <article class="guest">
    ${g.photo ? `<img src="${escapeHtml(g.photo)}" alt="${escapeHtml(g.name)}">` : ''}
    <div>
      <h3>${escapeHtml(g.name)}</h3>
      <p class="guest__role">${escapeHtml(g.role)}</p>
      ${g.links.map(l => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(' · ')}
    </div>
  </article>
`).join('');
```

Then `{{{guests_html}}}` in the template.

## Pattern 3 — Gradient hero with computed colours

The hero needs a colour pair derived from a single brand colour the user picked per item. The template can't compute — pre-compute and pass as fields:

```js
function shade(hex, amount) { /* lighten/darken */ }

const item = {
  ...,
  hero_from: rawColor,
  hero_to:   shade(rawColor, -0.2),
};
```

Template:

```html
<header class="hero" style="background:linear-gradient(135deg, {{hero_from}}, {{hero_to}})">
  <h1>{{title}}</h1>
</header>
```

Inline style with two substituted hex strings — works because the `{{}}` substitutions sit inside a CSS value, not as a CSS variable name. (Don't do this with user-supplied colours that haven't been validated — a malicious item could break out of the style attribute. For agent-curated colours this is fine.)

## Pattern 4 — Image gallery with thumbnails

Same drill. The agent renders the gallery HTML when shaping the item:

```js
const galleryHtml = `
<div class="gallery">
  ${item.images.map((img, i) => `
    <a href="${escapeHtml(img.full)}" class="gallery__item">
      <img src="${escapeHtml(img.thumb)}" alt="${escapeHtml(img.alt || `Bild ${i+1}`)}" loading="lazy">
    </a>
  `).join('')}
</div>`;
```

Schema gains `gallery_html: richtext`. Template renders `{{{gallery_html}}}`.

For a lightbox you can either inline a tiny vanilla JS handler in the item_template_html (works once per page load) or `tr-images` the gallery into a reusable partial.

## Pattern 5 — Spec table (for products, services, etc.)

For a fixed set of spec fields (price, dimensions, in-stock, lead time), just add the fields explicitly:

```
fields: [
  ...,
  {"name":"price_sek",  "type":"number"},
  {"name":"weight_g",   "type":"number"},
  {"name":"in_stock",   "type":"boolean"},
  {"name":"lead_days",  "type":"number"}
]
```

```html
<dl class="specs">
  {{#price_sek}}<dt>Pris</dt><dd>{{price_sek}} kr</dd>{{/price_sek}}
  {{#weight_g}}<dt>Vikt</dt><dd>{{weight_g}} g</dd>{{/weight_g}}
  <dt>Lagerstatus</dt><dd>{{#in_stock}}I lager{{/in_stock}}{{^in_stock}}Slut{{/in_stock}}</dd>
  {{#lead_days}}<dt>Leveranstid</dt><dd>{{lead_days}} dagar</dd>{{/lead_days}}
</dl>
```

(`{{^field}}…{{/field}}` is the inverse of `{{#field}}` — render when falsy.)

For variable specs (different products have different attributes), fall back to a pre-rendered `specs_html` field.

## Pre-rendering helpers — minimum viable

Every pre-render needs `escapeHtml`. Put this at the top of your data-prep script:

```js
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
```

Skip it only when you're certain the value can't carry user-supplied content (your own constants are fine; anything from a scrape, the user, or a model output goes through `escapeHtml`).

## When to flatten vs pre-render

Rough guideline:

| Situation | Approach |
|---|---|
| 1–N optional related fields, fixed shape | Flatten into prefixed fields (`guest_name`, `guest_role`, …) and use `{{#field}}` conditionals |
| List of items with internal structure (chapters, gallery, related-links) | Pre-render to a single `*_html` field |
| Computed values (formatted dates, derived colours, totals) | Pre-compute as a sibling field, substitute with `{{}}` |
| Conditional sections based on multiple fields ("show this when status=published AND has_video") | Pre-compute a boolean field; conditional in the template |
| Genuinely dynamic content that changes per visitor | Doesn't fit — the static template renders once at build. Move to client-side JS in the template body, or rethink the page. |

## Pitfalls

- **Forgetting `{{{ }}}` for pre-rendered HTML.** `{{chapters_html}}` (double braces) HTML-escapes the angle brackets and shows source code. Must be triple braces.
- **Mutating a published item's schema.** Removing or renaming a field that the template references silently produces empty sections. Keep templates in sync with schema changes.
- **Pre-rendered HTML drifts when you change the visual design.** The HTML for `chapters_html` was generated against the design as it was on import day. If you redo the look later, you need to re-prep + re-write every item's pre-rendered field, not just the template. Consider keeping the raw data (`chapters_json: textarea` with the original array stringified) so you can regenerate.
- **Inline `<script>` in `item_template_html` runs once per page.** That's fine for self-contained per-page widgets (the audio chapter-jumper above). If two collections need the same widget, factor it into a partial that both `item_template_html`s `<x-include>`.
- **Don't put credentials in pre-rendered HTML.** API keys, signed tokens — they go into the build output and end up on the public web. Run any prep step you wouldn't paste into a public Gist with that in mind.
