---
title: tr-brand — Branding and Design
description: Palette recipes by mood, typography pairings, and CSS variable setup for your Typeroll site.
---

**Triggers on:** "create a brand", "choose colours", "design the look", "make it feel more…"

## What it does

Claude picks a coherent colour palette and typography pairing based on the brand's mood, then applies it via `update_site_settings` and shows a preview.

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

## How Claude applies it

1. Asks (or infers from context) which mood fits the brand
2. Calls `update_site_settings` with the full `colors` and `fonts` objects
3. Calls `get_preview_link` so you can see the result
4. Iterates based on your feedback

You can ask for adjustments naturally: "make the accent more orange", "use a heavier serif for headings", "the background feels too cold".
