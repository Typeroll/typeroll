---
name: tr-header-footer
description: Vetted, robust header and footer presets to drop into the header/footer partials. Use when building or restyling a site's site-wide header or footer — start from a preset and restyle it instead of hand-rolling layout + overflow (the usual source of clipped logos and broken mobile menus).
---

# Header & footer presets

> **The buffer model (draft writes).** Every content write in this recipe
> (pages, blocks, partials, collection items) lands in an unsaved per-doc
> DRAFT — deploys and plain previews only see SAVED content. For recipe-style
> build work, pass `save: true` on write calls (the work is pre-approved by
> the task itself), or run `commit_working_copy` per doc before any
> `trigger_deploy`. Preview your drafts with `include_working_copy: true`.


Headers and footers are the two partials every page shows, and hand-rolling them
is where logos get clipped and mobile menus break. **Start from a preset below,
fill the placeholders, restyle with the site's colours — don't build the layout
from scratch.** Each preset is deliberately robust; the "why" notes call out the
traps it avoids.

## How to use

1. `read_site_settings` — grab `logo`, `site_name`, `tagline`, `contact.email`,
   and the colour palette.
2. `read_partial partial_id="header"` (and `footer`) — see what's already there;
   don't blow away a working one without reason.
3. Pick a preset, replace every `{{PLACEHOLDER}}`, adjust colours to the palette
   (the presets already read `--color-*` / `--font-heading` with fallbacks).
4. `update_partial partial_id="header" patch={ html_content: "…" } version="…"`.
5. **Preview and self-review in context** (see `tr-redesign-branch` step 6):
   the logo must be FULLY VISIBLE (not clipped), legible against its background,
   and the mobile layout must work at 390px. Screenshot the header region in
   context — never the logo element in isolation (that hides clipping).

Placeholders: `{{SITE_NAME}}`, `{{LOGO_URL}}`, `{{TAGLINE}}`, `{{EMAIL}}`, `{{YEAR}}`.

---

## Header A — Centered logo (minimal; landing pages)

```html
<header class="tr-hdr tr-hdr--center">
  <a class="tr-hdr-logo" href="/" aria-label="{{SITE_NAME}} — till startsidan">
    <img src="{{LOGO_URL}}" alt="{{SITE_NAME}}" />
  </a>
</header>
<style>
.tr-hdr--center{background:var(--color-surface,#fff);display:flex;justify-content:center;padding:clamp(1rem,2.5vw,1.6rem) 1.5rem}
.tr-hdr-logo{display:inline-block;line-height:0;transition:transform .15s ease}
.tr-hdr-logo:hover{transform:translateY(-1px)}
.tr-hdr-logo img{height:clamp(40px,6vw,58px);width:auto;display:block}
</style>
```

**Why it's robust:** no `overflow:hidden` anywhere near the logo (the #1 cause of a
clipped wordmark); the logo sizes by `height` with `width:auto` so it never
distorts and never gets cropped; symmetric padding so it can't collide with the
section below. If you want a tinted header, set a solid `background` — don't add a
glow that has to be clipped.

## Header B — Logo left + links right (no-JS responsive menu)

```html
<header class="tr-hdr tr-hdr--nav">
  <div class="tr-hdr-inner">
    <a class="tr-hdr-logo" href="/" aria-label="{{SITE_NAME}} — till startsidan">
      <img src="{{LOGO_URL}}" alt="{{SITE_NAME}}" />
    </a>
    <input type="checkbox" id="tr-nav-toggle" class="tr-nav-toggle" aria-hidden="true" />
    <label for="tr-nav-toggle" class="tr-nav-burger" aria-label="Meny"><span></span><span></span><span></span></label>
    <nav class="tr-hdr-nav" aria-label="Huvudmeny">
      <a href="/">Start</a>
      <a href="#">Sidan ett</a>
      <a href="#">Sidan två</a>
      <a class="tr-hdr-cta" href="#kontakt">Kontakta oss</a>
    </nav>
  </div>
</header>
<style>
.tr-hdr--nav{background:var(--color-surface,#fff);border-bottom:1px solid rgba(0,0,0,.06)}
.tr-hdr-inner{max-width:1160px;margin:0 auto;padding:.9rem 1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.tr-hdr-logo{line-height:0}
.tr-hdr-logo img{height:clamp(36px,4.6vw,50px);width:auto;display:block}
.tr-hdr-nav{display:flex;align-items:center;gap:clamp(1rem,2.4vw,2rem);font-family:var(--font-heading),sans-serif;font-weight:600}
.tr-hdr-nav a{color:var(--color-text,#1a1a1a);text-decoration:none}
.tr-hdr-nav a:hover{color:var(--color-primary,#1F4FB8)}
.tr-hdr-cta{background:var(--color-primary,#1F4FB8);color:var(--color-primary-fg,#fff);padding:.6rem 1.2rem;border-radius:999px}
.tr-hdr-cta:hover{filter:brightness(1.05);color:var(--color-primary-fg,#fff)}
.tr-nav-toggle{display:none}
.tr-nav-burger{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:.4rem}
.tr-nav-burger span{width:24px;height:2px;background:var(--color-text,#1a1a1a);border-radius:2px}
@media(max-width:760px){
  .tr-nav-burger{display:flex}
  .tr-hdr-nav{flex-basis:100%;flex-direction:column;align-items:stretch;gap:.2rem;max-height:0;overflow:hidden;transition:max-height .25s ease}
  .tr-hdr-nav a{padding:.7rem .2rem}
  .tr-nav-toggle:checked ~ .tr-hdr-nav{max-height:60vh}
}
</style>
```

**Why it's robust:** the mobile menu is a pure-CSS checkbox toggle — no JS to break,
no library. The `overflow:hidden` is ONLY on the collapsing nav list (never on the
header or the logo), so the logo is always fully visible. Links use site colour
variables so it matches the brand automatically. The header wraps (`flex-wrap`) so
nothing overflows the viewport on narrow screens.

---

## Footer A — Centered minimal

```html
<footer class="tr-ftr tr-ftr--center">
  <div class="tr-ftr-inner">
    <div class="tr-ftr-brand">{{SITE_NAME}}</div>
    <p class="tr-ftr-tag">{{TAGLINE}}</p>
    <p class="tr-ftr-contact"><a href="mailto:{{EMAIL}}">{{EMAIL}}</a></p>
    <p class="tr-ftr-copy">© {{YEAR}} {{SITE_NAME}}</p>
  </div>
</footer>
<style>
.tr-ftr--center{background:var(--color-primary,#163C8C);color:rgba(255,255,255,.78)}
.tr-ftr--center .tr-ftr-inner{max-width:1120px;margin:0 auto;padding:2.6rem 1.5rem;text-align:center;display:grid;gap:.45rem}
.tr-ftr-brand{font-family:var(--font-heading),sans-serif;font-weight:800;font-size:1.35rem;color:#fff}
.tr-ftr-tag{margin:0;font-size:1rem;color:rgba(255,255,255,.85)}
.tr-ftr-contact{margin:.15rem 0 0}
.tr-ftr-contact a{color:#fff;text-decoration:none;font-weight:600}
.tr-ftr-contact a:hover{text-decoration:underline}
.tr-ftr-copy{margin:.8rem 0 0;font-size:.85rem;color:rgba(255,255,255,.55)}
</style>
```

## Footer B — Three columns (brand · links · contact)

```html
<footer class="tr-ftr tr-ftr--cols">
  <div class="tr-ftr-grid">
    <div class="tr-ftr-col">
      <div class="tr-ftr-brand">{{SITE_NAME}}</div>
      <p class="tr-ftr-tag">{{TAGLINE}}</p>
    </div>
    <nav class="tr-ftr-col" aria-label="Sidfot">
      <a href="/">Start</a>
      <a href="#">Sidan ett</a>
      <a href="#">Sidan två</a>
    </nav>
    <div class="tr-ftr-col">
      <p class="tr-ftr-contact"><a href="mailto:{{EMAIL}}">{{EMAIL}}</a></p>
    </div>
  </div>
  <p class="tr-ftr-copy">© {{YEAR}} {{SITE_NAME}}</p>
</footer>
<style>
.tr-ftr--cols{background:var(--color-primary,#163C8C);color:rgba(255,255,255,.78)}
.tr-ftr--cols .tr-ftr-grid{max-width:1120px;margin:0 auto;padding:3rem 1.5rem 1.4rem;display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:2rem}
.tr-ftr--cols .tr-ftr-brand{font-family:var(--font-heading),sans-serif;font-weight:800;font-size:1.35rem;color:#fff;margin-bottom:.4rem}
.tr-ftr--cols .tr-ftr-tag{margin:0;color:rgba(255,255,255,.8);max-width:34ch}
.tr-ftr--cols .tr-ftr-col{display:grid;gap:.5rem;align-content:start}
.tr-ftr--cols nav a{color:rgba(255,255,255,.85);text-decoration:none}
.tr-ftr--cols nav a:hover{color:#fff;text-decoration:underline}
.tr-ftr-contact a{color:#fff;text-decoration:none;font-weight:600}
.tr-ftr--cols .tr-ftr-copy{max-width:1120px;margin:0 auto;padding:0 1.5rem 2.4rem;font-size:.85rem;color:rgba(255,255,255,.55)}
@media(max-width:680px){.tr-ftr--cols .tr-ftr-grid{grid-template-columns:1fr;gap:1.4rem}}
</style>
```

**Why these footers are robust:** the columns collapse to one at 680px (no
horizontal scroll); all colours come from `--color-*` with fallbacks; the contact
is a real `mailto:` link; nothing relies on fixed heights. Swap `--color-primary`
for a custom dark if the brand's primary is too light for white text.

---

## Restyling notes

- The logo always comes from `read_site_settings → logo`. If it's `null`, set it
  first (upload + `update_site_settings`) — don't hard-code a path.
- For a **shaped transition** from the header/footer into the page, don't build a
  wave band by hand — that belongs to the adjacent `core/section` via its
  `divider_top` / `divider_bottom` (see `tr-redesign-branch`).
- Keep the brand mark + a way home. Even a dramatic redesign keeps the logo
  linking to `/`.
