# Missing blocks, motion and scroll-driven media: proposals

Status: 2026-11-07. Built at render version 14 (branch
`feat/layered-responsive-defaults`), except one open decision: where a
video is turned into film frames (section 4). Collected after the render
version 14 review of all 45 core block types. The block reference
(docs-site `tools/blocks/library.mdx`) documents what was built, with the
hooks for site CSS and scripts.

Built beyond the original proposal: text over images (darkening from a side
or behind the text, plates of six kinds and six shapes including glass that
blurs the image, and a section text position per screen size), and the
`motion` site setting.

## Open: frames from a video

`core/scroll_film` takes frames (a pattern or a list) or a video file. A
video plays as the page scrolls, smoothly only when every frame is a
keyframe. Deriving frames from an uploaded video needs ffmpeg or WebCodecs,
neither of which runs in a Worker. The choices:

- the portal browser at upload (WebCodecs): no server cost, but MCP and API
  uploads would not get frames;
- a Cloud media job: one path for every upload, a new service to run;
- the publication build, with ffmpeg as a dependency of the frozen
  publication: no new service, a large download in every customer build.

Until then, authors export frames themselves (the reference says how).

## Where we are

| Capability | Today |
|---|---|
| Background image | Hero only. Sections and containers have a colour or a gradient. |
| Background video | Hero only: a muted, looping video file with the image as poster, a pause button, hidden for reduced motion. |
| Video | `video` block: YouTube/Vimeo embed (privacy mode, click-to-load) or a file in the browser player. |
| Motion | Carousel autoplay, accordion open/close, header hide on scroll, consent banner fade. No entrance animation, no parallax, nothing tied to scroll position. |
| Custom motion | A custom block type or site style may use `@keyframes` and `transition`. No script, so no scroll-linked behaviour beyond what CSS alone can do. |

## 1. Background media on sections and containers — medium

Move the hero's background video into a shared field group and give it to
`section`, `container` (and `cta`) from render version 14 or 15:

- `background_image` with focal point and fit;
- `background_video` (a file: MP4/WebM; no YouTube or Vimeo, which bring
  their branding, cookies and no reliable loop);
- `overlay` colour and opacity, with the existing on-colour contrast check
  against the overlay instead of the bare background;
- `video_on_phones: poster | play` (default poster: saves data and battery).

Runtime, shared with the hero:

- start only when the section enters the viewport, pause when it leaves;
- a visible pause button (WCAG 2.2.2 for anything moving longer than 5 s);
- reduced motion or the proposed site setting `motion: reduced` shows the
  poster and never downloads the video.

The platform derives the poster from the video if none is given, and warns
when a background video is larger than a budget (for example 6 MB).

## 2. Entrance animation — small to medium

A `motion` field on section, container, grid, columns and repeaters:
`none` (default) | `fade` | `rise` | `scale`, plus `stagger: true` for
the children of grids and repeaters.

Rules that keep it safe:

- **Content is visible by default.** The animation only runs from a hidden
  state the stylesheet itself sets inside an animation, never an
  `opacity:0` that waits for script. Search engines, AI crawlers, printouts,
  screenshots and visitors without script see everything.
- CSS scroll-driven animation (`animation-timeline: view()`), supported in
  Chromium and Safari 26; Firefox shows the content without animation. No
  runtime script is needed.
- Short and subtle: at most 400 ms of effect and 24 px of travel, one shared
  easing token.
- Off for reduced motion and for `motion: reduced` in site settings.
- Each element animates once and is not hidden again on scroll up.

## 3. Sticky steps (scrollytelling) — medium

A new block `scroll_steps`: a sticky media column (image, video or a block)
next to text steps that scroll past. Each step can change the media,
highlight a part of it or play a short clip.

- Without script, with reduced motion and on phones, it is an ordinary list
  of steps, each with its own media above the text.
- With script, an `IntersectionObserver` swaps the media for the active
  step, with a cross-fade.
- Good for product tours, processes and case stories; it covers most of what
  people mean by "scroll film" at a fraction of the cost.

## 4. Scroll-driven film — large

A new block `scroll_film`: a section several viewport heights tall where the
scroll position scrubs a film frame by frame, with text captions that come
and go at chosen points (`captions[]` with start and end in percent).

- **Frames, not video seeking.** Setting `currentTime` on a normal video
  stutters because browsers decode from the previous keyframe. Draw an image
  sequence on a `<canvas>` instead, the technique Apple's product pages use.
  The visitor's browser loads the frames progressively: the first frame
  first, then every eighth, then the rest.
- **The platform derives the frames.** The user uploads one video; the
  platform turns it into WebP/AVIF frames in two sizes (phone and desktop)
  and stores them as derived media. This cannot run in a Worker. Options:
  - in the portal browser at upload with WebCodecs (no server cost; MCP
    uploads need the same path, so the browser upload is not enough on its
    own);
  - a media processing job in Cloud;
  - not in the organization build engine, which does not auto-update and
    must not depend on newer scripts.
- Frame count and size are capped (for example 150 frames, 12 MB per size)
  with a warning in the editor.
- Without script and for reduced motion: the poster frame and the captions
  as ordinary text in order. Search engines index the captions.

## 5. Missing blocks

Ordered by how often a typical business site needs them.

| Block | Why | Size |
|---|---|---|
| `stats` (key figures) | "120 customers, 15 years, 98 %": very common on landing pages. Number, unit, label; optional count-up on entrance (motion rules as above). Today it is built from headings in a grid. | small |
| `map` | Contact pages. A consent-aware facade with a static preview image that loads OpenStreetMap or Google Maps on click, like the video facade. `embed` covers it today without consent handling. | medium |
| Gallery lightbox | `gallery` has grid, masonry and justified layouts but opening an image full size is missing. A `lightbox: true` field using `<dialog>`, keyboard and swipe. | small |
| Logo marquee | A `marquee` layout for `logo_cloud`: a slowly moving row, paused on hover, focus and reduced motion. | small |
| `announcement_bar` | A site-wide strip above the header (campaign, opening hours, notice), dismissible, set once in the header template. | small |
| `timeline` | History and milestones. Could be a repeater layout rather than a block. | small |
| `audio` | Podcasts and sound clips: the browser player with title and transcript link. | small |
| Before/after image | Renovation, retouching, design work. A slider with keyboard support. | small |

Not proposed: social sharing buttons (third-party scripts; a plain link list
does the job), countdown timers (go stale after the date), and chat widgets
(an integration, not a block).

## Order

1. Background media on sections, since it is mostly moving existing hero code.
2. Entrance animation and the `motion` site setting together, since they share
   the reduced-motion rules.
3. `stats`, lightbox and logo marquee: small and frequently asked for.
4. `scroll_steps`.
5. `scroll_film`, after deciding where the frame extraction runs.
6. The rest of the missing blocks as sites need them.

Each new field takes `min_render_version`, so published sites at versions
1–13 are unchanged.
