/**
 * Cascade layers for platform CSS (render version 14). Every platform
 * stylesheet is emitted inside a named layer; site and page CSS stay
 * unlayered, so a plain site rule wins over any platform default without
 * !important. See docs/plans/responsive-defaults-and-cascade.md.
 */
export const PLATFORM_LAYERS = ['reset', 'base', 'tokens', 'platform', 'instance'] as const;
/**
 * Where each kind of platform CSS goes. The content well, block CSS and site
 * styles share one layer, in the order and with the specificity they had
 * before layers, so their relationships are unchanged (a component rule with
 * deliberately low specificity still yields to a block's own rule). Reset and
 * element defaults sit below them, per-block values above, site CSS above all.
 */
const LAYER_OF = { reset: 'reset', base: 'base', tokens: 'tokens', content: 'platform', blocks: 'platform', styles: 'platform', instance: 'instance' } as const;
export type PlatformLayer = keyof typeof LAYER_OF;

export const LAYERED_RENDER_VERSION = 14;

export function usesCascadeLayers(renderVersion: number | undefined): boolean {
  return (renderVersion ?? 1) >= LAYERED_RENDER_VERSION;
}

/** Declares the layer order once, before any layered stylesheet. */
export const PLATFORM_LAYER_ORDER_CSS = `@layer ${PLATFORM_LAYERS.map(layer => `typeroll.${layer}`).join(',')};`;

/** Wrap platform CSS in its layer from render version 14; older versions are unchanged. */
export function platformLayer(layer: PlatformLayer, css: string, renderVersion: number | undefined): string {
  if (!css || !usesCascadeLayers(renderVersion)) return css;
  return `@layer typeroll.${LAYER_OF[layer]}{\n${css}\n}`;
}
