---
name: tr-design-review
description: Use to review a deployed/previewed Typeroll page like a designer — a MEASURED multi-dimension pass (responsive, a11y, functional, content, SEO, performance) that emits a per-dimension scorecard and an explicit OK verdict. Run it before telling the user a design is approved; it's the "how" for tr-redesign-branch's approval round.
---

# Review a design — measured, not glanced

A design review is a MEASUREMENT, not a look. The failure mode is reporting
"looks good" off a couple of screenshots — which silently misses overflow at
untested widths, sub-AA contrast, broken/blank images, and small touch targets.
This skill is the deterministic routine: per dimension, a check you RUN (a
browser-eval snippet or a curl), and a scorecard you fill with PASS / FAIL /
UNTESTED. Never report "approved" off a partial pass — list what you didn't test
as caveats.

`tr-redesign-branch` step 6 lists the dimensions (the "what"). This is the "how".

## Cardinal rule: a screenshot is evidence, not proof

**Full-page screenshots lie about lazy-loaded images.** A page with
`loading="lazy"` images below the fold will screenshot with BLANK boxes where
those images sit — they hadn't entered the viewport when the capture fired. If
you trust that, you will report a non-existent "empty illustration box" gap.
(This has happened — on a real review, across three variants at once.)

So, always:

- **Before any full-page capture**, scroll the whole page to trigger lazy loads
  and let it settle (snippet in §5), THEN screenshot.
- **Verify every suspected blank/broken image via the DOM** (`naturalWidth` after
  scroll), never from the screenshot. A real broken image has `complete === true
  && naturalWidth === 0`; a lazy one that just hasn't loaded has `complete ===
  false` — scroll it into view and re-check before calling it broken.

## Setup

1. Get a URL for the version under review. While iterating, use the DB-live
   `get_preview_link` (mint once, reuse — defaults to a 24h TTL) — it renders
   from the DB with no build, so fixes show on reload without re-deploying, and
   it's the loop for the review-fix-recheck cycle. For a FINAL bit-for-bit check
   of the compiled output before merge, deploy once (`trigger_deploy
   version="<branch>"` → poll `get_deploy_status` → use the immutable
   `deploy_url`, a Cloudflare Pages hash URL). Review the SAME url end to end.
2. The snippets below run in a browser tool's "evaluate JavaScript" (Playwright /
   chrome-devtools / puppeteer MCP). **One origin per eval:** the iframe trick
   needs same-origin, so run each variant's snippet on its own page (different
   `*.pages.dev` hashes are cross-origin → `contentDocument` is null).
3. If you run several variants with one shared browser profile, do them
   SEQUENTIALLY — parallel browser agents on one profile contaminate each other's
   tabs/screenshots.

## The dimensions — run each, record the result

### 1. Responsive — width ladder 390/768/1024/1440/1920, zero overflow

Measure horizontal overflow at every width in ONE eval using same-origin iframes
(each iframe is its own layout viewport, so `@media` fires correctly — no 15
resizes):

```js
async () => {
  const url = location.href, out = [];
  for (const w of [390,768,1024,1440,1920]) {
    const f = document.createElement('iframe');
    f.style.cssText = `width:${w}px;height:2400px;border:0;position:fixed;left:-99999px;top:0`;
    document.body.appendChild(f);
    await new Promise(r => { f.onload = r; f.src = url; });
    await new Promise(r => setTimeout(r, 700));
    const d = f.contentDocument, culprits = [];
    for (const el of d.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > w + 1 && r.width <= w + 40 && r.width > 4)
        culprits.push(el.tagName.toLowerCase() + '.' + (el.className||'').toString().slice(0,40));
    }
    out.push({ w, hOverflow: d.documentElement.scrollWidth - w, n: culprits.length, sample: [...new Set(culprits)].slice(0,6) });
    f.remove();
  }
  return out;
}
```

PASS = `hOverflow <= 0` at every width. A decorative element flagged while
`hOverflow` is 0 is clipped by an `overflow:hidden` parent (no scrollbar) — a
non-issue. Then eyeball one tablet (768) capture for stacking — but capture
AFTER the scroll-settle in §5.

### 2. Accessibility — compute contrast, don't eyeball

```js
() => {
  const L = c => { const a = c.map(v => (v/=255, v<=.03928?v/12.92:((v+.055)/1.055)**2.4)); return .2126*a[0]+.7152*a[1]+.0722*a[2]; };
  const P = c => { const m = c.match(/rgba?\(([^)]+)\)/); if(!m) return null; const p = m[1].split(',').map(parseFloat); return {rgb:[p[0],p[1],p[2]], a:p[3]??1}; };
  const R = (f,b) => { const x=L(f),y=L(b),h=Math.max(x,y),l=Math.min(x,y); return (h+.05)/(l+.05); };
  const bg = el => { let e=el; while(e){ const s=getComputedStyle(e); if(s.backgroundImage!=='none') return {img:1}; const c=P(s.backgroundColor); if(c&&c.a>.5) return {rgb:c.rgb}; e=e.parentElement; } return {rgb:[255,255,255]}; };
  const bad=[], seen=new Set();
  for (const el of document.body.querySelectorAll('*')) {
    const t=[...el.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');
    if(!t) continue;
    const r=el.getBoundingClientRect(); if(r.width<2||r.height<2) continue;
    const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||+s.opacity<.1) continue;
    const fg=P(s.color); if(!fg) continue;
    const b=bg(el); if(b.img) continue; // can't compute over an image — eyeball hero text separately
    const cr=R(fg.rgb,b.rgb), fs=parseFloat(s.fontSize), fw=+s.fontWeight||400;
    const need = (fs>=24||(fs>=18.66&&fw>=700)) ? 3 : 4.5;
    if (cr<need) { const k=t.slice(0,30)+cr.toFixed(2); if(seen.has(k))continue; seen.add(k);
      bad.push({txt:t.slice(0,45), ratio:+cr.toFixed(2), need, fs:Math.round(fs), fw, color:s.color, bg:'rgb('+b.rgb.join(',')+')'}); }
  }
  return { failures: bad.length, items: bad.slice(0,15) };
}
```

PASS = 0 failures (AA: body ≥4.5:1, large/UI ≥3:1). Fix a failure by deepening
the offending colour token. Text over an image background is skipped — eyeball
those (hero overlays) for legibility separately.

Structure + alt + landmarks, same eval session:

```js
() => {
  const h=[...document.querySelectorAll('h1,h2,h3,h4')].map(e=>+e.tagName[1]);
  const skips=h.map((v,i)=>i&&v-h[i-1]>1?`${h[i-1]}->${v}`:0).filter(Boolean);
  const imgs=[...document.querySelectorAll('img')];
  const inputs=[...document.querySelectorAll('input:not([type=hidden]),textarea,select')];
  const labelFor=new Set([...document.querySelectorAll('label[for]')].map(l=>l.getAttribute('for')));
  return {
    h1: h.filter(x=>x===1).length, levelSkips: skips,
    imgsMissingAlt: imgs.filter(i=>i.getAttribute('alt')===null).length,
    landmarks: ['header','nav','main','footer'].filter(t=>document.querySelector(t)),
    unlabeledInputs: inputs.filter(i=>!(i.id&&labelFor.has(i.id))&&!i.getAttribute('aria-label')).map(i=>i.name||i.id),
  };
}
```

PASS = exactly one `h1`, `levelSkips` empty, `imgsMissingAlt` 0, all four
landmarks present, `unlabeledInputs` empty. (Decorative images SHOULD have
`alt=""` — that's not "missing".)

Touch targets — interactive elements ≥44px at mobile. Run in a 390px iframe;
EXCLUDE `aria-hidden` (the form honeypot is a visible-sized but hidden input —
counting it is a false positive) and inline text links inside `p`/`li`:

```js
async () => {
  const f=document.createElement('iframe');
  f.style.cssText='width:390px;height:2400px;border:0;position:fixed;left:-99999px;top:0';
  document.body.appendChild(f);
  await new Promise(r=>{ f.onload=r; setTimeout(r,3000); f.src=location.href; });
  await new Promise(r=>setTimeout(r,700));
  const d=f.contentDocument, small=[];
  if(d) for (const el of d.querySelectorAll('a,button,input:not([type=hidden]),textarea,select,[role=button]')) {
    const r=el.getBoundingClientRect(); if(r.width<2||r.height<2) continue;
    const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden'||+s.opacity<.1) continue;
    if(el.getAttribute('aria-hidden')==='true') continue;
    if(el.tagName==='A'&&el.closest('p,li')) continue;
    if(r.height<44||r.width<44) small.push({tag:el.tagName.toLowerCase(), txt:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,24), w:Math.round(r.width), h:Math.round(r.height)});
  }
  f.remove(); return { undersized: small };
}
```

Also confirm `:focus-visible` and `prefers-reduced-motion` exist (grep the page
HTML: `grep -c 'focus-visible' page.html`, `grep -c 'prefers-reduced-motion'`).
Note honestly: presence in CSS ≠ verified per-element — tab through live if you
claim keyboard focus works.

### 3. Functional — console, links, form

- **Console:** read the browser tool's console messages after load. PASS = 0
  errors/warnings.
- **Links:** PASS = no `href="#"`/empty; every in-page `#anchor` has a matching
  `id`.
- **Form (markup — does NOT prove a live submit):** curl the page and verify the
  `<form>` `action` is the real submit endpoint, the hidden `_token` is
  non-empty, the honeypot is present + `aria-hidden`, required fields have
  `required`, the email field is `type="email"`. State explicitly that you did
  NOT submit (a live POST creates a real submission) unless you actually did.

### 4. Content — verbatim, no placeholders

`grep -Ei 'lorem|ipsum|\{\{|placeholder|TODO|FIXME' page.html` → 0. Copy matches
the live page (the source of truth) verbatim.

### 5. Broken / blank images (the anti-lazy-load check — run THIS before trusting any screenshot)

```js
async () => {
  const H=document.body.scrollHeight;
  for(let y=0;y<=H;y+=400){ window.scrollTo(0,y); await new Promise(r=>setTimeout(r,120)); }
  window.scrollTo(0,0); await new Promise(r=>setTimeout(r,1500));
  const imgs=[...document.querySelectorAll('img')];
  const empty=[]; // genuinely empty boxes: large, no text/img/svg/bg-image
  for (const el of document.querySelectorAll('div,section,figure')) {
    const r=el.getBoundingClientRect(); if(r.width<160||r.height<140) continue;
    if((el.innerText||'').trim()||el.querySelector('img,svg,picture,canvas,video')) continue;
    if(getComputedStyle(el).backgroundImage!=='none') continue;
    empty.push({cls:(el.className||'').toString().slice(0,36), w:Math.round(r.width), h:Math.round(r.height)});
  }
  return {
    broken: imgs.filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.src.slice(-45)), // real failures
    stillLoading: imgs.filter(i=>!i.complete).map(i=>i.src.slice(-45)),               // lazy, scroll first
    emptyBoxes: empty.slice(0,8),                                                     // true placeholders
  };
}
```

PASS = `broken` empty, `emptyBoxes` empty. A non-empty `emptyBoxes` is a genuine
unfilled illustration slot (fill it — pages shouldn't be text deserts). NOW
capture screenshots (the page is scrolled-and-settled, images loaded).

### 5b. Clipped artwork — the logo (and any brand image) cut off by its own frame

The single most-repeated visual bug: the header logo rendered with its top/edges
sliced. It produces ZERO page overflow (§1 misses it), the image isn't broken
(§5 misses it), and at full-page screenshot scale a few clipped pixels are easy
to glance past. So MEASURE it: does the artwork's rendered content touch the edge
of its own box on any side? Content flush against the frame (gap ≈ 0) = clipped
or about-to-clip. Don't just check the logo — check it, then trust the number.

For a raster/`<img>` logo, draw it to a same-origin canvas and scan the border
rows/cols for opaque pixels (cross-origin taints the canvas — fetch the asset to
a localhost file first, as in §setup, or measure on the asset directly):

```js
async (url) => { // url = the logo's currentSrc, served same-origin
  const img = new Image(); await new Promise((r,e)=>{img.onload=r;img.onerror=e;img.src=url;});
  const h = 64, w = Math.round(h*img.naturalWidth/img.naturalHeight);
  const c = document.createElement('canvas'); c.width=w; c.height=h;
  const x = c.getContext('2d'); x.drawImage(img,0,0,w,h);
  const d = x.getImageData(0,0,w,h).data, op=(px)=>d[px*4+3]>20;
  let top=h,bot=0,left=w,right=0;
  for(let y=0;y<h;y++)for(let xx=0;xx<w;xx++)if(op(y*w+xx)){top=Math.min(top,y);bot=Math.max(bot,y);left=Math.min(left,xx);right=Math.max(right,xx);}
  return { topGap:top, bottomGap:h-1-bot, leftGap:left, rightGap:right }; // any 0 → flush/clipped
}
```

PASS = every gap ≥ ~2% of the dimension. A `0` on any side means the artwork (or
its stroke) sits on the frame — for an SVG that's a viewBox trimmed flush to the
art (look for `-trim`/`-tight` in the filename); the fix is to re-export the SVG
with viewBox padding (e.g. widen `viewBox` by ~8% each side) so the stroke never
touches the edge. Verify the fix by re-running this with the patched asset. (A
heavy `stroke-width` + `paint-order="stroke"` outline makes a flush viewBox clip
visibly — and small header renders make it worse, so also check the logo isn't
shrunk below ~64–72px in the header.)

Also confirm no ANCESTOR clips the logo: walk the logo's parents for
`overflow:hidden|clip` combined with a fixed height or negative/overlap margin —
and always judge the logo from a screenshot of the header REGION in context,
never the logo element in isolation (an element screenshot re-renders the full
art and hides the clip).

**The inverse bug — an image FLOATING inside its frame (don't blame the file).**
A full-bleed illustration that renders with a margin of empty frame around it
usually isn't a bad asset — it's CSS. In blocks-mode the site-template's global
`:where(.page-content) img{ margin:1rem 0 }` (and a default `border-radius`)
leaks onto any `<img>` you didn't reset, so a framed hero/figure gets a 1rem gap
inside its frame and looks like it "floats". Before re-cropping or regenerating,
**open the actual image file** (`curl` the `.avif`/`.png`) — if the motif fills
the file edge-to-edge, the float is CSS: set `margin:0` (and `border-radius:0`)
on the framed `<img>` (e.g. `.your-frame img{margin:0}` or a blanket
`.your-scope img{margin:0}`). Measure it: the `<img>`'s `getBoundingClientRect`
should equal its frame's inner box (no gap). Only when the *file itself* has
built-in background margin (motif ≪ frame) is cropping the right fix.

### 6. Findable (SEO/meta) — curl, fast

`<title>` (≤60 chars) + meta description present + sensible; `og:title/description/image`;
`canonical`; `favicon` + `apple-touch-icon`; `<html lang>`; branches must be
`noindex`. One curl + greps covers it.

### 7. Fast (performance)

PASS signals: no render-blocking JS you didn't add; responsive variants
(`srcset` + AVIF/WebP) so a 1024px asset isn't shipped to a 380px slot;
`width`/`height` or aspect-ratio set (no layout shift); **below-fold images
`loading="lazy"`, above-fold `eager`**. Flag a section that eager-loads every
image, or a multi-hundred-KB original served when a small AVIF variant exists.

### 8. Cross-browser

The same CSS renders differently per engine. Re-check in another engine if you
can. If only Chromium is available, say so as UNTESTED and statically flag risky
props: `backdrop-filter` without fallback, `-webkit-`-only masks, `100vh` on
mobile (prefer `100svh`), `position:sticky` inside `overflow`.

## Deliver a scorecard + an explicit verdict

Report a table — one row per dimension, value PASS / FAIL(detail) / UNTESTED —
then a one-line verdict. Rules:

- "Approved" requires PASS on responsive, a11y, functional, content, SEO,
  performance. Untested dimensions (commonly cross-browser, live form submit) are
  listed as CAVEATS, not silently dropped — an OK with caveats is honest; an
  unqualified "approved" off a partial pass is not.
- Brand FIT (palette/voice matching `brand.md`) is a direction judgment, not a
  pass/fail defect — call it out separately so the user decides direction.
- If you fixed anything mid-review, just reload the DB-live preview and re-run
  the affected dimension before signing off — no re-deploy needed (deploy only
  for the final compiled-output check, if any).

See `tr-redesign-branch` for the surrounding branch → preview → approve → merge
flow; this skill is its measured approval round.
