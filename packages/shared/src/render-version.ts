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
