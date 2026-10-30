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
