const BREAKPOINT_ORDER = ['mobile','tablet','laptop','desktop','wide'];
const STEPS = {type_size:{xs:1,sm:1,md:1,lg:1,xl:1,'2xl':1,'3xl':1},space:{none:1,xs:1,sm:1,md:1,lg:1,xl:1},leading:{tight:1,snug:1,normal:1,relaxed:1,loose:1}};
/** Strict length grammar: no URLs, variables, declarations or nested expressions. */
export function scaleLength(value) {
  if (typeof value !== 'string' || value.length > 160) return false;
  const length = '(?:0|\\d+(?:\\.\\d+)?(?:px|rem|em))';
  return new RegExp(`^${length}$`).test(value) ||
    new RegExp(`^clamp\\(\\s*${length}\\s*,\\s*${length}\\s*[+\\-]\\s*\\d+(?:\\.\\d+)?vw\\s*,\\s*${length}\\s*\\)$`).test(value);
}
export function designScalesError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'design_scales must be an object';
  for (const [scale, steps] of Object.entries(value)) {
    if (!Object.hasOwn(STEPS, scale)) return `Unknown design scale: ${scale}`;
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) return `design_scales.${scale} must be an object`;
    for (const [step, val] of Object.entries(steps)) {
      if (!Object.hasOwn(STEPS[scale], step)) return `Unknown ${scale} step: ${step}`;
      const scalar = (v) => scale === 'leading' ? typeof v === 'string' && /^(?:1(?:\.\d+)?|2(?:\.0+)?)$/.test(v) : scaleLength(v);
      const valid = scalar(val) || (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length > 0 && Object.entries(val).every(([bp, v]) => BREAKPOINT_ORDER.includes(bp) && scalar(v)));
      if (!valid) return `design_scales.${scale}.${step} must be ${scale === 'leading' ? 'a line height from 1 to 2' : 'a nonnegative px/rem/em length or clamp(min, length + vw, max)'} or a responsive map of those values`;
    }
  }
  return null;
}
export function typographyError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'typography must be an object';
  for (const [key, v] of Object.entries(value)) {
    const range = key === 'line_length' ? [40, 90] : key === 'rhythm' ? [0.5, 2] : ['ratio_mobile','ratio_desktop'].includes(key) ? [1.1, 1.5] : null;
    if (!range || typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) return `typography.${key} must be ${range ? `a number from ${range[0]} to ${range[1]}` : 'a supported setting'}`;
  }
  return null;
}
