/**
 * Render versions protect existing sites from platform output changes.
 *
 * A site renders with the version stored in `SiteSettings.render_version`.
 * A missing value means 1, the output Core produced when versions were
 * introduced. New sites are created at LATEST_RENDER_VERSION.
 *
 * Any change to platform CSS or block markup that alters an existing page is
 * gated on `renderVersion >= N` and listed below. Upgrading a site is an
 * explicit, previewable settings change.
 * See docs/plans/design-system-and-render-versions.md.
 */

export interface RenderVersionInfo {
  version: number;
  /** Core release that introduced this version. */
  core_version: string;
  title: string;
  /** User-facing descriptions of what renders differently from the previous version. */
  changes: string[];
}

export const RENDER_VERSIONS: readonly RenderVersionInfo[] = [
  {
    version: 1,
    core_version: '0.2.57',
    title: 'Baseline',
    changes: ['Block markup and platform CSS as rendered by Core 0.2.56.'],
  },
  {
    version: 2,
    core_version: '0.2.57',
    title: 'Semantic headings and readable defaults',
    changes: [
      'A heading\'s eyebrow and new subtitle are grouped with the heading in an <hgroup> and omitted when empty.',
      'The eyebrow is no longer faded (opacity 0.7). It uses its chosen style, else the site\'s Eyebrow style, else a full-contrast default; the subtitle likewise defaults to the Lead style.',
      'A custom class on a heading or button block is placed on the heading or link element itself instead of the block wrapper. Rewrite CSS such as `.my-class .block-heading-text` as `.my-class`.',
      'Text on primary-coloured buttons and badges is black or white, whichever reads better on the primary colour, instead of always white.',
    ],
  },
  {
    version: 3,
    core_version: '0.2.58',
    title: 'Palette-derived theme tokens',
    changes: [
      'Subtle panel backgrounds (table headers, code, placeholders, tabs) use the site\'s Surface colour instead of a fixed light grey.',
      'Borders are derived from the text and background colours instead of a fixed grey, so they stay visible on dark backgrounds.',
      'Text on secondary-coloured buttons is black or white, whichever reads better on the secondary colour.',
    ],
  },
  {
    version: 4,
    core_version: '0.2.60',
    title: 'Lists in core blocks',
    changes: [
      'Accordion items render as expandable sections; "Default open" opens the first or every item.',
      'Pricing plan features and team member social links render; excluded features are marked.',
      'An icon without a link no longer sits in an empty link, so icons work inside linked cards.',
      'A team member card is a link only when it has one.',
      'A container set to link but without an address renders as a plain container.',
    ],
  },
  {
    version: 5,
    core_version: '0.2.65',
    title: 'Multi-step form navigation',
    changes: [
      'In a multi-step form the button reads "Continue" ("Fortsätt" on Swedish sites) on every step but the last; the last step keeps the form\'s submit text. A step\'s own button label applies on every render version.',
      'Multi-step forms show a "Back" ("Tillbaka") button from the second step. It returns to the previous step with the entered values kept; set the form\'s "allow_back" to false to hide it.',
      'A step that starts with a form heading block no longer also shows the step title above it.',
    ],
  },
  {
    version: 6,
    core_version: '0.2.79',
    title: 'Browser-default font smoothing',
    changes: [
      'Text uses the browser\'s default font smoothing and text rendering. Earlier versions set `-webkit-font-smoothing: antialiased` and `text-rendering: optimizeLegibility` on every page, which on macOS draws dark text on a light background thinner and lighter than other sites at the same font weight.',
      'A site that wants the thinner rendering, for example for light text on a dark background, sets Typography → Font smoothing to "Antialiased" (`fonts.smoothing: "antialiased"`). The setting applies on every render version.',
    ],
  },
  {
    version: 7,
    core_version: '0.2.79',
    title: 'Video, ratings and carousel controls',
    changes: [
      'Video blocks play: a YouTube or Vimeo address becomes the provider\'s embed address (YouTube without cookies), and a file address plays in the browser\'s own player. Poster, autoplay (always muted), loop, muted, controls and lazy loading apply; the player has an accessible title ("title", default "Video").',
      'A hero with a video file address plays it as a muted, looping background behind the text, with the image as its poster and a pause button. It does not play when the visitor prefers reduced motion.',
      'A testimonial with a rating shows it as whole stars, with "Rating: 4 out of 5" ("Betyg: 4 av 5" on Swedish sites) for screen readers.',
      'Carousels (repeater layout "carousel", for example testimonials) get previous and next buttons, a dot per item and optional autoplay with a pause button, as their settings say. Items scroll inside the carousel; autoplay stops while the visitor points at or focuses the carousel, and never runs when they prefer reduced motion. Without JavaScript the carousel still scrolls.',
    ],
  },
  {
    version: 8,
    core_version: '0.2.79',
    title: 'Text colour on theme colours by APCA',
    changes: [
      'The automatic text colour on primary, secondary and accent (buttons, badges, tabs, call-to-action sections and styles using "on primary", "on secondary" or "on accent") is black or white by APCA, the perceptual contrast measure, instead of the WCAG 2 ratio. On mid-dark saturated colours such as teal, green or medium blue, text that was near-black becomes white, which reads better; for example white on #00a19c (APCA Lc 63.9) instead of #111827 (Lc 44).',
      'A text colour chosen for a theme colour (Colors → Text on primary/secondary/accent, `colors.on_primary`, `colors.on_secondary`, `colors.on_accent`) applies on every render version and is not changed by this upgrade.',
    ],
  },
  {
    version: 9,
    core_version: '0.2.81',
    title: 'Container shadows above the next block',
    changes: [
      'A container with a shadow ("subtle" or "header") is raised above the blocks after it (`position: relative; z-index: 10`), so its shadow shows over the next block instead of being painted over by that block\'s background or image. A sticky container keeps z-index 100, and menus that open from a shadowed header land above the next block.',
      'A container with a shadow is now the containing block of its absolutely positioned content.',
      'The "header" shadow is `0 2px 6px rgb(0 0 0 / 20%)` instead of `0 2px 5px`, as common site header CSS draws it.',
    ],
  },
  {
    version: 10, core_version: '0.2.114', title: 'Fluid typography and component rhythm',
    changes: [
      'Named type and space steps use fluid defaults controlled by the site ratios and rhythm. Explicit scale overrides remain authoritative.',
      'Heading role margins apply to editorial flow, not component titles. Opening headings in containers and sections have no extra top margin.',
      'Prose uses the configured line length. Preview cards and boxed headings before rebuilding an existing site.',
    ],
  },
  {
    version: 11, core_version: '0.2.115', title: 'Contextual heading and navigation spacing',
    changes: [
      'Editorial headings retain their rhythm inside columns and grids, including after images. Opening headings remain flush with their container; component titles keep their own spacing.',
      'Article heading spacing also works without a saved role library. Explicit heading spacing overrides apply once.',
      'Navigation link groups keep 44px default touch targets without an additional vertical gap. Explicit gaps and compact desktop density are preserved.',
    ],
  },
  {
    version: 12, core_version: '0.2.132', title: 'Constrained containers fill columns',
    changes: [
      'A container with width narrow, normal or wide inside a container that is a column at every breakpoint fills the column up to its maximum width and stays centered. Before, it shrank to its content, so an archive with one card was narrower than one with many.',
      'Such column containers carry data-column-only="true". Rows, and containers that become rows at some breakpoint, are unchanged.',
    ],
  },
  {
    version: 13, core_version: '0.2.140', title: 'Long words stay on small screens',
    changes: [
      'A container that is a column at every breakpoint keeps its children on one line (flex-wrap: nowrap). Before, a child with a long word, address or inline code wider than the screen made every child and the page that wide, so phones scrolled sideways.',
      'Paragraphs, list items and headings in Text blocks, and the Heading block\'s heading, eyebrow and subtitle, break a word that does not fit on a line. Code blocks in Text scroll inside the text column.',
      'Navigation links can have a group label: a visible title above the links that also names the list for screen readers. Lists without a label render as before.',
    ],
  },
  {
    version: 14, core_version: '0.3.7', title: 'Layered platform styles and balanced phone layouts',
    changes: [
      'Platform CSS (reset, base, theme values, blocks, site styles and per-block values) is emitted in cascade layers. Site and page CSS are unlayered, so a plain class or element rule overrides a platform default without !important.',
      'Phones get smaller headings by default (a type ratio of 1.15 below the site setting\'s explicit value), so a heading no longer breaks into lines of a few words.',
      'Pages that end with content outside a section get space before the footer. A Heading block between other blocks in a section has more space above than below, like a heading inside a Text block.',
      'Block defaults fit every width: long words wrap in every block, cards and grids stay inside their column, touch targets are at least 24px, a call to action without a background uses the theme colours, and card padding is compact on phones.',
      'A navigation link\'s minimum height (44px by default, or link_min_height_px) includes its vertical padding, so a heading above a stacked list of links stays further from the links than they are from each other.',
      'Sections, containers, heroes, feature rows and calls to action share three content widths (narrow, normal and wide), so blocks of the same width start at the same edge on wide screens. Heroes and calls to action get a width setting; a block placed directly in the page follows its width instead of a fixed 1080px.',
      'Built-in labels left at their English default (Learn more, On this page, Menu, Previous, Next, Download PDF and others) render in the page language.',
      'A list of ordinary Pages with no filter and no chosen Pages lists the current Page\'s children, instead of every Page on the site.',
      'A feature row inside a tab, column, grid cell or container drops its default outer padding and fills the block around it, and it stacks by its own width, so it also stacks in a narrow column on a wide screen.',
      'Two site settings: date_format (medium, long, numeric, iso or a pattern) and content_widths (the narrow, normal and wide widths in px).',
      'Page dates and card dates read in the page language ("12 okt. 2026" on a Swedish page). A Page date block\'s format setting now applies; card dates keep the machine-readable date in datetime.',
      'An entrance animation (motion: fade, rise, scale or custom) on sections, containers, grids, columns, lists and the larger content blocks. It plays once as the block scrolls in; containers bring in their blocks one after another. Content is visible without script, in print and for visitors who prefer reduced motion.',
      'Sections get a background image, and sections, containers and calls to action a background video file: it starts in view, pauses out of view, has a pause button, shows the image on phones unless asked to play, and never plays for reduced motion. A darkening layer (background_overlay) keeps white text readable.',
      'Text over images: darkening evenly, from one side or behind the text in a chosen color; a plate behind the text (solid, see-through, glass that blurs the image, or a full-width band) in a rounded, square, pill, organic, slanted or custom shape; and in sections a text position per screen size with a minimum height.',
      'A gallery opens its images larger on click, with previous and next, the arrow keys and swiping (lightbox, on by default). A logo cloud can be a slowly moving row (layout: marquee) with a pause button.',
      'The site setting motion: reduced turns off entrance animations, carousel autoplay, background and hero videos, moving rows, counting figures and scroll films for every visitor.',
    ],
  },
  {
    version: 15, core_version: '0.3.9', title: 'Menus with submenus and fonts in use',
    changes: [
      'A Navigation links block can show one of the site\'s menus (source: menu, chosen by id or by a location such as location:primary) instead of its own links. Page items take the page\'s current title and address, so renames and moves follow; unpublished or deleted pages drop out. The current page is marked with aria-current and its parent items with block-nav-parent--current. A menu that does not exist renders an empty list. Blocks with their own links render as before.',
      'Menu items with children get a submenu with a button that opens it (aria-expanded, Escape closes). Submenus are "auto" by default: a dropdown panel under the item in a row of links, an accordion in a column and in the mobile menu. They can also always show their links (expanded) or be left out (none). A submenu whose items have children of their own is laid out in columns; headings and short descriptions show in it.',
      'Without script a dropdown opens on hover and keyboard focus, and an accordion shows its links. The small submenu script ships only on pages with a menu-sourced Navigation links block.',
      'Fonts load only the weights and italics the site uses (its styles, block weights and their defaults, and bold and italic rich text, plus fonts.load) instead of a fixed 400–700, and no italics unless the site has italic text. A variable family loads as one file covering the range in use. The body family\'s upright Latin file is preloaded.',
      'A self-hosted family has its own metric-matched fallback face, measured from the copied files, so text keeps its place while the font loads.',
      'Two more font roles: display (large headings and heroes) and accent (eyebrows and quotes), as --font-display and --font-accent. Unset, they use the heading and body families. Blocks and styles choose them like the other roles.',
      'Authored text and HTML can use {{site.name}} and {{site.fields.<name>}} (text, number or true/false values, escaped), so a template names the site it is inserted into. Before, only {{site.current_year}} expanded and other tokens showed as written.',
    ],
  },
];

export const LATEST_RENDER_VERSION = RENDER_VERSIONS[RENDER_VERSIONS.length - 1].version;

/** Version for sites whose settings predate render versions. */
export const BASELINE_RENDER_VERSION = 1;

export function isRenderVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= LATEST_RENDER_VERSION;
}

/** The version a site renders with. Missing or unknown values fall back to the baseline. */
export function resolveRenderVersion(value: unknown): number {
  return isRenderVersion(value) ? value : BASELINE_RENDER_VERSION;
}

/** Versions newer than `current`, oldest first: what an upgrade would change. */
export function renderVersionsAfter(current: number): RenderVersionInfo[] {
  return RENDER_VERSIONS.filter(info => info.version > current);
}

export interface RenderVersionStatus {
  version: number;
  latest: number;
  /** What upgrading to the latest version would change, oldest first. */
  upgrades: RenderVersionInfo[];
}

export function renderVersionStatus(stored: unknown): RenderVersionStatus {
  const version = resolveRenderVersion(stored);
  return { version, latest: LATEST_RENDER_VERSION, upgrades: renderVersionsAfter(version) };
}

/** The template and styles a block type renders with at a render version. */
export function blockOutputForVersion(
  blockType: Pick<import('./types.js').BlockType, 'template' | 'styles' | 'render_versions'> & { script?: string },
  version: number | undefined,
): { template: string; styles: string; script: string } {
  const resolved = resolveRenderVersion(version);
  let template = blockType.template ?? '';
  let styles = blockType.styles ?? '';
  // A script added in a later version must not reach older sites either: it
  // also adds the runtime hook (data-block-type) to every instance.
  let script = blockType.script ?? '';
  const entries = [...(blockType.render_versions ?? [])].sort((a, b) => a.from - b.from);
  for (const entry of entries) {
    if (entry.from > resolved) break;
    if (entry.template !== undefined) template = entry.template;
    if (entry.styles !== undefined) styles = entry.styles;
    if (entry.script !== undefined) script = entry.script;
  }
  return { template, styles, script };
}
