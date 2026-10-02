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
    core_version: '0.2.64',
    title: 'Multi-step form navigation',
    changes: [
      'In a multi-step form the button reads "Continue" ("Fortsätt" on Swedish sites) on every step but the last; the last step keeps the form\'s submit text. A step\'s own button label applies on every render version.',
      'Multi-step forms show a "Back" ("Tillbaka") button from the second step. It returns to the previous step with the entered values kept; set the form\'s "allow_back" to false to hide it.',
      'A step that starts with a form heading block no longer also shows the step title above it.',
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
  blockType: Pick<import('./types.js').BlockType, 'template' | 'styles' | 'render_versions'>,
  version: number | undefined,
): { template: string; styles: string } {
  const resolved = resolveRenderVersion(version);
  let template = blockType.template ?? '';
  let styles = blockType.styles ?? '';
  const entries = [...(blockType.render_versions ?? [])].sort((a, b) => a.from - b.from);
  for (const entry of entries) {
    if (entry.from > resolved) break;
    if (entry.template !== undefined) template = entry.template;
    if (entry.styles !== undefined) styles = entry.styles;
  }
  return { template, styles };
}
