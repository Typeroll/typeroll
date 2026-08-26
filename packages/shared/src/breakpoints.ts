// Five-breakpoint responsive system for the block renderer.
//
// Names are Tailwind-compatible so the mental model translates if the
// author ever drops out to custom CSS. Mobile-first: the `mobile` value
// is the baseline, and each subsequent breakpoint *overrides* the value
// from `mobile` upward via @media (min-width: …).
//
// The five breakpoints are deliberately fixed in the data model. Adding
// or renaming a breakpoint later requires a data migration; keep the
// list small and aligned with what real designs actually need.

export const BREAKPOINTS = {
  mobile: { min: 0, label: 'Mobile (< 640)' },
  tablet: { min: 640, label: 'Tablet (≥ 640)' },
  laptop: { min: 1024, label: 'Laptop (≥ 1024)' },
  desktop: { min: 1280, label: 'Desktop (≥ 1280)' },
  wide: { min: 1536, label: 'Wide (≥ 1536)' },
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/**
 * Order matters — mobile first, then each larger breakpoint. Use this when
 * iterating responsive values so inheritance is deterministic.
 */
export const BREAKPOINT_ORDER: readonly Breakpoint[] = [
  'mobile',
  'tablet',
  'laptop',
  'desktop',
  'wide',
] as const;

/**
 * A responsive value is either a scalar (applies everywhere) or a sparse
 * mobile-first object with at most one entry per breakpoint. Missing entries
 * inherit from the previous breakpoint in `BREAKPOINT_ORDER`.
 */
export type ResponsiveValue<T> = T | Partial<Record<Breakpoint, T>>;

/**
 * Type guard: is this value the per-breakpoint object form? Plain scalars
 * (string, number, boolean, null, undefined) return false. Arrays return
 * false too — they're legitimate scalar values in some schemas (e.g.
 * select-multi).
 */
export function isResponsiveValue<T>(
  value: unknown,
): value is Partial<Record<Breakpoint, T>> {
  if (value == null) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // Must contain at least one known breakpoint key
  for (const bp of BREAKPOINT_ORDER) {
    if (bp in (value as object)) return true;
  }
  return false;
}

/**
 * Resolve a responsive value at a specific breakpoint, walking mobile-first.
 * If `mobile` isn't set explicitly, the first defined breakpoint upward
 * becomes the effective baseline. If nothing is set at all, returns
 * `undefined`.
 *
 * Example:
 *   resolveResponsive({ tablet: 'lg' }, 'mobile')  → 'lg' (inherits up)
 *   resolveResponsive({ mobile: 'sm', laptop: 'lg' }, 'tablet') → 'sm'
 *   resolveResponsive('md', 'desktop')             → 'md' (scalar)
 */
export function resolveResponsive<T>(
  value: ResponsiveValue<T> | undefined,
  bp: Breakpoint,
): T | undefined {
  if (value == null) return undefined;
  if (!isResponsiveValue<T>(value)) return value as T;

  // Walk back from `bp` toward mobile; first defined value wins.
  const order = BREAKPOINT_ORDER;
  const idx = order.indexOf(bp);
  for (let i = idx; i >= 0; i--) {
    const candidate = value[order[i]!];
    if (candidate !== undefined) return candidate;
  }
  // Walk forward (mobile-first fallback when `mobile` is not set and the
  // requested breakpoint is below the first defined one — shouldn't happen
  // with `bp >= mobile`, but cheap insurance).
  for (let i = idx + 1; i < order.length; i++) {
    const candidate = value[order[i]!];
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/**
 * Expand a responsive value into a fully-populated record covering every
 * breakpoint. Useful for the editor (show inherited values) and for the
 * renderer's CSS compiler (it needs to know the value at each step).
 */
export function expandResponsive<T>(
  value: ResponsiveValue<T> | undefined,
): Record<Breakpoint, T | undefined> {
  const out = {} as Record<Breakpoint, T | undefined>;
  for (const bp of BREAKPOINT_ORDER) {
    out[bp] = resolveResponsive(value, bp);
  }
  return out;
}

/**
 * The list of breakpoints whose @media rule is non-trivial. Skips `mobile`
 * because it has min-width: 0 — the baseline is always emitted at the top
 * of the style block without a query.
 */
export const BREAKPOINTS_ABOVE_MOBILE: readonly Exclude<Breakpoint, 'mobile'>[] = [
  'tablet',
  'laptop',
  'desktop',
  'wide',
] as const;

/**
 * Build the @media query string for a breakpoint. Mobile returns an empty
 * string because that level is the baseline (no media query needed).
 */
export function mediaQuery(bp: Breakpoint): string {
  if (bp === 'mobile') return '';
  return `@media (min-width: ${BREAKPOINTS[bp].min}px)`;
}
