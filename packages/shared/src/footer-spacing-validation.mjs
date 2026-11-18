const BREAKPOINT_ORDER = ['mobile', 'tablet', 'laptop', 'desktop', 'wide'];
const TOKEN_SCALES = { space: { none: 0, xs: 1, sm: 2, md: 3, lg: 4, xl: 5 } };
/** No arbitrary CSS: steps follow the site's scale; numbers are an explicit px exception. */
export function footerSpacingError(value) {
  const scalar = (v) => typeof v === 'number' ? Number.isFinite(v) && v >= 0 && v <= 320
    : typeof v === 'string' && Object.hasOwn(TOKEN_SCALES.space, v);
  if (scalar(value)) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length && entries.every(([key, v]) => BREAKPOINT_ORDER.includes(key) && scalar(v))) return null;
  }
  return 'footer_spacing must be a spacing step (none, xs, sm, md, lg, xl), 0–320 px, or a non-empty mobile/tablet/laptop/desktop/wide map of those values';
}
