import { designScalesCss, responsiveDesignScalesCss, resolvedDesignScales, TYPOGRAPHY_DEFAULTS, typographyError, validColor, type DesignScales, type TypographySettings } from './design-tokens.js';
import { resolveBreakpointWidths } from './breakpoints.js';
import { resolveRenderVersion } from './render-version.js';
/** The reserved system family never triggers a network font request. */
export const SYSTEM_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export function isSystemFont(value: string): boolean {
  return ['system', 'system-ui'].includes(value.trim().toLowerCase());
}
export function fontFamilyCss(value: string): string {
  if (isSystemFont(value)) return SYSTEM_FONT_STACK;
  // Family names are data, never CSS declarations or HTML.
  return `'${value.replace(/[\\'\r\n<>;{}]/g, '')}'`;
}

/** Values for `SiteSettings.fonts.smoothing`. */
export const FONT_SMOOTHING_VALUES = ['auto', 'antialiased'] as const;
export type FontSmoothing = (typeof FONT_SMOOTHING_VALUES)[number];
export function isFontSmoothing(value: unknown): value is FontSmoothing {
  return typeof value === 'string' && (FONT_SMOOTHING_VALUES as readonly string[]).includes(value);
}

/**
 * Text rendering on `<body>`.
 *
 * Until render version 6 the template reset set `-webkit-font-smoothing:
 * antialiased` and `text-rendering: optimizeLegibility` on every site. On
 * macOS that drops stem darkening, so dark text on a light background draws
 * thinner and lighter than the browser default at the same weight, and a
 * migrated site looked lighter than its original. From version 6 the browser
 * default applies unless the site chooses `antialiased` (for example for light
 * text on a dark background). Older versions keep the reset's rule unless the
 * site chose a value.
 */
export function fontSmoothingCss(smoothing: unknown, renderVersion: number): string {
  if (smoothing === 'antialiased') return 'body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}';
  if (smoothing === 'auto' || renderVersion >= 6) return '';
  return 'body{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}';
}

/**
 * Theme tokens written into every page head from SiteSettings. Missing optional
 * values fall back so older settings documents never emit "undefined" CSS.
 * Published pages and preview emit the same block.
 */
export function siteThemeCss(settings: Pick<import('./types.js').SiteSettings, 'colors' | 'fonts'> & { render_version?: unknown; design_scales?: DesignScales; typography?: TypographySettings; responsive_breakpoints?: import('./breakpoints.js').ResponsiveBreakpoints | null }): string {
  const colors = settings.colors ?? ({} as Partial<import('./types.js').SiteSettings['colors']>);
  const fonts = settings.fonts ?? ({} as Partial<import('./types.js').SiteSettings['fonts']>);
  const fluid = resolveRenderVersion(settings.render_version) >= 10;
  const scales = resolvedDesignScales(settings.design_scales, settings.typography, fluid, fonts.size_base ?? 16);
  const typography = { ...TYPOGRAPHY_DEFAULTS, ...(!typographyError(settings.typography) ? settings.typography : {}) };
  return `:root{
  --color-primary:${colors.primary};
  --color-secondary:${colors.secondary};
  --color-accent:${colors.accent};
  --color-background:${colors.background};
  --color-surface:${colors.surface ?? '#f8fafc'};
  --color-surface-hover:${colors.surface_hover && validColor(colors.surface_hover) ? colors.surface_hover : 'color-mix(in srgb,var(--color-surface) 92%,var(--color-text))'};
  --color-text:${colors.text};
  --color-text-light:${colors.text_light ?? '#64748b'};
  --font-heading:${fontFamilyCss(fonts.heading ?? 'Inter')};
  --font-body:${fontFamilyCss(fonts.body ?? 'Inter')};
  --font-mono:${fonts.mono ? fontFamilyCss(fonts.mono) : 'ui-monospace'};
  ${designScalesCss(scales)}${fluid ? `\n  --type-rhythm:${typography.rhythm};\n  --measure-prose:${typography.line_length}ch;\n  --section-padding:var(--space-xl);\n  --spacing-xs:var(--space-xs);--spacing-sm:var(--space-sm);--spacing-md:var(--space-md);--spacing-lg:var(--space-lg);--spacing-xl:var(--space-xl);` : ''}
  --font-size-base:${fonts.size_base ?? 16}px;
}${responsiveDesignScalesCss(scales, resolveBreakpointWidths(settings.responsive_breakpoints))}${fluid ? ':where([data-block=prose]){max-inline-size:var(--measure-prose)}' : ''}${fontSmoothingCss(fonts.smoothing, resolveRenderVersion(settings.render_version))}`;
}

/** Webfont families a site loads from Google Fonts (system families excluded). */
export function webFontFamilies(heading: string, body: string, mono?: string): string[] {
  return Array.from(new Set([heading, body, mono].filter((value): value is string => !!value && !isSystemFont(value))));
}

/**
 * CLS guard used while a webfont loads: a size-adjusted Arial stands in with
 * Inter-like metrics. Published pages and preview emit the same rule.
 */
export const WEBFONT_FALLBACK_CSS = "@font-face{font-family:'tr-fallback';src:local('Arial');size-adjust:107%;ascent-override:90%;descent-override:22%;line-gap-override:0%}body{font-family:var(--font-body),'tr-fallback',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}h1,h2,h3,h4,h5,h6{font-family:var(--font-heading),'tr-fallback',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}";
