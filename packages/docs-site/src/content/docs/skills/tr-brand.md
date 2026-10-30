---
title: tr-brand — Branding and Design
description: Palette recipes by mood, typography pairings, and CSS variable setup for your Typeroll site.
---

**Triggers on:** "create a brand", "choose colours", "design the look", "make it feel more…"

## What it does

The AI agent picks a coherent colour palette and typography pairing based on the brand's mood, then applies it via `update_site_settings` and shows a preview.

## Mood presets

### Nordic / Minimal

Calm, professional, lots of white space.

```
primary:    #1a1a2e   (deep navy)
secondary:  #f8f9fa   (off-white)
accent:     #e8c86e   (warm gold)
background: #ffffff
surface:    #f4f4f6
text:       #1a1a2e
text_light: #6b7280
```

Fonts: **Inter** (headings) + **Inter** (body)

### Warm / Artisan

Earthy, handcrafted, inviting.

```
primary:    #2d1b0e   (dark espresso)
secondary:  #f5ede0   (cream)
accent:     #c4622d   (terracotta)
background: #faf7f2
surface:    #f0e8d8
text:       #2d1b0e
text_light: #8b6f47
```

Fonts: **Playfair Display** (headings) + **Lato** (body)

### Modern / Tech

Clean, confident, forward-looking.

```
primary:    #0f172a   (slate 900)
secondary:  #f1f5f9   (slate 100)
accent:     #3b82f6   (blue 500)
background: #ffffff
surface:    #f8fafc
text:       #0f172a
text_light: #64748b
```

Fonts: **Space Grotesk** (headings) + **Inter** (body)

### Editorial / Dark

Dramatic, high-contrast, gallery-feel.

```
primary:    #f5f0e8   (warm white)
secondary:  #1a1a1a   (near-black)
accent:     #e8c86e   (gold)
background: #111111
surface:    #1e1e1e
text:       #f5f0e8
text_light: #9ca3af
```

Fonts: **Cormorant Garamond** (headings) + **Inter** (body)

## Text on theme colours

Text on primary, secondary and accent (buttons, badges, tabs, call-to-action
sections) is black or white automatically. When the brand specifies it, the
agent sets `colors.on_primary`, `colors.on_secondary` or `colors.on_accent`
instead of writing custom CSS, and reports the contrast the response returns.
See [Settings](../../tools/settings/#text-on-theme-colours).

## Typography pairings

| Heading            | Body           | Character            |
| ------------------ | -------------- | -------------------- |
| Playfair Display   | Lato           | Classic editorial    |
| Fraunces           | Inter          | Modern + humanist    |
| Space Grotesk      | Inter          | Tech/startup         |
| Cormorant Garamond | Source Serif 4 | Luxury / literary    |
| DM Serif Display   | DM Sans        | Refined + accessible |
| Clash Display      | Satoshi        | Bold/contemporary    |

## Font size scale

```
size_base: 16   (1rem = 16px — the default)
```

Headings scale from this base using Typeroll's built-in fluid type scale.

## Fonts on the published site

Use exact Google Fonts family names. By default the site self-hosts them:
when a publication is prepared, Typeroll copies the font files into the build,
so visitors never contact Google, before or after a consent choice. A name
Google does not serve falls back silently to the next font, so the agent checks
`/_typeroll/fonts/fonts.css` and the font files on the published test address;
the preview loads fonts from Google and cannot show this. Loading fonts from
Google instead (`fonts.delivery: "google"`) sends each visitor's IP address to
Google and is a privacy decision for the site owner. See
[`fonts` settings](../../tools/settings/#fonts-object).

## How the AI agent applies it

1. Asks (or infers from context) which mood fits the brand
2. Calls `update_site_settings` with the full `colors` and `fonts` objects
3. Calls `get_preview_link` so you can see the result
4. Iterates based on your feedback

You can ask for adjustments naturally: "make the accent more orange", "use a heavier serif for headings", "the background feels too cold".

## Palette and scale consistency

Configure colours and font families in site settings. Use palette names and
named styles in blocks; document deliberate exceptions in `decisions.md`.
Core 0.2.106 adds block palette names, named size/spacing steps and
`lint_design_tokens`. Follow the [design-token guide](/docs/guides/design-tokens/)
and the site starter’s `workflows/design.md`; on older Core use palette CSS variables.
