import { footerSpacingError } from './footer-spacing-validation.mjs';
export { footerSpacingError } from './footer-spacing-validation.mjs';
import { BREAKPOINT_ORDER, resolveBreakpointWidths, resolveResponsive, type Breakpoint, type ResponsiveValue } from './breakpoints.js';
import { scaleValue, TOKEN_SCALES } from './design-tokens.js';
import { platformLayer } from './cascade-layers.js';
import type { Block, Page, SiteSettings } from './types.js';
import type { SiteStyle, StyleProps } from './site-styles.js';

export type FooterSpacingStep = keyof typeof TOKEN_SCALES.space;
export type FooterSpacing = ResponsiveValue<FooterSpacingStep | number>;
export interface FooterSpacingWarning { code: 'footer_spacing_zero'; block_id: string; breakpoints: Breakpoint[]; message: string }


const zero = (v: unknown) => v === 0 || typeof v === 'string' && /^(?:none|0(?:\.0+)?(?:px|rem|em)?)$/.test(v.trim());
const authored = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== 'auto';
function bottomOfPadding(value: string): string {
  const parts = value.trim().split(/\s+(?![^()]*\))/);
  return parts[2] ?? parts[0] ?? '';
}
function styleAt(style: SiteStyle | undefined, bp: Breakpoint): StyleProps {
  const out = { ...style?.base };
  for (const key of BREAKPOINT_ORDER.slice(1, BREAKPOINT_ORDER.indexOf(bp) + 1)) Object.assign(out, style?.at?.[key as keyof NonNullable<SiteStyle['at']>]);
  return out;
}
/** Explicit block data or a selected style owns its spacing, including zero. */
export function blockFooterSpace(block: Block, bp: Breakpoint, styles: readonly SiteStyle[] = []): { own: boolean; zero: boolean } {
  const data = block.data ?? {};
  const padding = ['padding_bottom_px', 'padding_y_px', 'padding_y'].map(key => resolveResponsive(data[key], bp)).find(authored);
  const selected = styles.find(style => style.id === data.style_id);
  const props = styleAt(selected, bp);
  const margin = block.style_overrides?.spacing_after ?? props.space_after;
  const styledPadding = props.padding ? bottomOfPadding(props.padding) : undefined;
  const values = [padding, margin, styledPadding].filter(authored);
  // Custom CSS is intentionally opaque. Never overwrite it or claim it has zero spacing.
  const custom = [block.style_overrides?.custom_css, data.inline_style, selected?.css].some(css => typeof css === 'string' && /(?:^|[;{\s])(?:padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|--padding[a-z_-]*|--block-py|--page-end-space)\s*:/i.test(css));
  return { own: Boolean(custom) || values.length > 0, zero: !custom && values.length > 0 && values.every(zero) };
}

/** Attach only when the site opts in. Marks the actual rendered root, so omitted
 * optional blocks and global blocks do not leave a phantom last block in CSS. */
export function footerSpacingAttributes(block: Block, styles: readonly SiteStyle[] = []): Record<string, string> {
  return Object.fromEntries(BREAKPOINT_ORDER.flatMap(bp => [
    ...(blockFooterSpace(block, bp, styles).own ? [[`data-footer-own-${bp}`, '']] : []),
    ...(block.hidden_on?.includes(bp) ? [[`data-footer-hidden-${bp}`, '']] : []),
  ]));
}

/** Shared by the static layout and preview; no JS, measurement or post-load jump.
 * Unconfigured sites keep byte-for-byte historical spacing. Container default
 * padding is moved to the main's end, rather than added a second time. */
export function footerSpacingCss(settings: Pick<SiteSettings, 'footer_spacing' | 'footer_min_spacing' | 'responsive_breakpoints' | 'render_version'>, page: Pick<Page, 'footer_spacing'>): string {
  const none = page.footer_spacing === 'none';
  if (!none && settings.footer_spacing == null && settings.footer_min_spacing == null) return '';
  if (settings.footer_spacing != null && footerSpacingError(settings.footer_spacing) || settings.footer_min_spacing != null && footerSpacingError(settings.footer_min_spacing)) return '';
  if (none) return platformLayer('content', '.page-content{--page-end-space:0px;padding-block-end:0}', settings.render_version);
  const widths = resolveBreakpointWidths(settings.responsive_breakpoints);
  const rules = BREAKPOINT_ORDER.map((bp, index) => {
    const next = BREAKPOINT_ORDER[index + 1];
    const last = `:nth-last-child(1 of :not(style,script,template,[hidden],[data-footer-hidden-${bp}]))`;
    const automatic = `${last}:not([data-footer-own-${bp}])`;
    const root = `.page-content--blocks > ${automatic}`;
    const value = resolveResponsive(settings.footer_spacing ?? 0, bp)!;
    const gap = typeof value === 'number' ? `${value}px` : scaleValue('space', value)!;
    const minimum = resolveResponsive(settings.footer_min_spacing ?? 0, bp)!;
    const floor = typeof minimum === 'number' ? `${minimum}px` : scaleValue('space', minimum)!;
    const spacing = settings.footer_min_spacing == null ? gap : `max(${gap},${floor})`;
    const css = `.page-content{--page-end-space:0px;padding-block-end:${spacing}}` +
      `.page-content--blocks{padding-block-end:${settings.footer_min_spacing == null ? '0' : floor}}` +
      `.page-content--blocks:has(> ${automatic}){padding-block-end:${spacing}}` +
      `${root}{margin-block-end:0}` +
      `${root}:is([data-block="section"],[data-block="container"],[data-block="semantic-container"],[data-block="hero"]){padding-block-end:0}`;
    return `@media (min-width:${widths[bp]}px)${next ? ` and (max-width:${widths[next] - .02}px)` : ''}{${css}}`;
  });
  return platformLayer('content', rules.join('\n'), settings.render_version);
}

const TEXT_OR_FORM = new Set(['core/text', 'core/prose', 'core/heading', 'core/rich_heading', 'core/list', 'core/form', 'core/navigation_form']);
/** Conservative warning: known text/form ending with an explicit zero, no
 * positive inner spacing, and no deliberate page-level edge-to-edge choice. */
export function footerSpacingWarnings(blocks: Block[], page: Pick<Page, 'footer_spacing'>, styles: readonly SiteStyle[] = [], minimum?: FooterSpacing): FooterSpacingWarning[] {
  if (page.footer_spacing === 'none') return [];
  const found = new Map<string, Breakpoint[]>();
  for (const bp of BREAKPOINT_ORDER) {
    const floor = minimum == null ? null : resolveResponsive(minimum, bp);
    if (typeof floor === 'number' && floor > 0 || typeof floor === 'string' && floor !== 'none') continue;
    let current = blocks.filter(b => !b.hidden_on?.includes(bp)).at(-1);
    const root = current;
    if (!root || !blockFooterSpace(root, bp, styles).zero) continue;
    let safe = true;
    while (current?.children?.length) {
      const child = current.children.filter(b => !b.hidden_on?.includes(bp)).at(-1);
      if (!child) break;
      const space = blockFooterSpace(child, bp, styles);
      if (space.own && !space.zero) { safe = false; break; }
      current = child;
    }
    if (safe && current && TEXT_OR_FORM.has(current.type)) found.set(root.id, [...(found.get(root.id) ?? []), bp]);
  }
  return [...found].map(([block_id, breakpoints]) => ({ code: 'footer_spacing_zero', block_id, breakpoints,
    message: `The last block (${block_id}) ends with text or a form and explicitly has no bottom spacing at ${breakpoints.join(', ')}. Clear its bottom spacing to use the site default, add spacing, or choose “Meet the footer edge to edge” in Page metadata if this is intentional.` }));
}
