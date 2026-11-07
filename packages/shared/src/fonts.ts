import { contentWidthsCss } from './site-display-settings.js';
import { designScalesCss, responsiveDesignScalesCss, resolvedDesignScales, TYPOGRAPHY_DEFAULTS, typographyError, validColor, type DesignScales, type TypographySettings } from './design-tokens.js';
import { resolveBreakpointWidths } from './breakpoints.js';
import { resolveRenderVersion } from './render-version.js';
import { FONT_PLAN_RENDER_VERSION, FONT_ROLE_CSS, fontFallbackFacesCss, plannedFallbackFace, type FontPlan } from './font-plan.js';
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
/** Default phone type ratio from render version 14 (1.2 before). */
export const PHONE_TYPE_RATIO = 1.15;

export function siteThemeCss(settings: Pick<import('./types.js').SiteSettings, 'colors' | 'fonts'> & { render_version?: unknown; design_scales?: DesignScales; typography?: TypographySettings; responsive_breakpoints?: import('./breakpoints.js').ResponsiveBreakpoints | null; content_widths?: unknown; font_plan?: FontPlan | null }): string {
  const colors = settings.colors ?? ({} as Partial<import('./types.js').SiteSettings['colors']>);
  const fonts = settings.fonts ?? ({} as Partial<import('./types.js').SiteSettings['fonts']>);
  const fluid = resolveRenderVersion(settings.render_version) >= 10;
  // Version 14: phones use a gentler type ratio unless the site chose one, so headings stay balanced.
  const validTypography = settings.typography && !typographyError(settings.typography) ? settings.typography : undefined;
  const phoneTypography = resolveRenderVersion(settings.render_version) >= 14 && validTypography?.ratio_mobile === undefined
    ? { ...validTypography, ratio_mobile: PHONE_TYPE_RATIO } : settings.typography;
  const scales = resolvedDesignScales(settings.design_scales, phoneTypography, fluid, fonts.size_base ?? 16);
  const typography = { ...TYPOGRAPHY_DEFAULTS, ...(!typographyError(settings.typography) ? settings.typography : {}) };
  // Version 14: a webfont name always carries the fallback stack, so text styled with var(--font-*) never shows the browser's default serif.
  const v14 = resolveRenderVersion(settings.render_version) >= 14;
  // Version 15: a family copied with the publication also has its own metric-matched fallback face.
  const v15 = resolveRenderVersion(settings.render_version) >= FONT_PLAN_RENDER_VERSION;
  const ownFallback = (family: string) => {
    const face = v15 ? plannedFallbackFace(settings.font_plan, family) : null;
    return face ? `${fontFamilyCss(face)}, ` : '';
  };
  const withFallback = (family: string) => v14 && !isSystemFont(family) ? `${fontFamilyCss(family)}, ${ownFallback(family)}'tr-fallback', ${SYSTEM_FONT_STACK}` : fontFamilyCss(family);
  const roleFonts = v15 ? `\n  --font-display:${fonts.display ? withFallback(fonts.display) : 'var(--font-heading)'};\n  --font-accent:${fonts.accent ? withFallback(fonts.accent) : 'var(--font-body)'};` : '';
  return `:root{
  --color-primary:${colors.primary};
  --color-secondary:${colors.secondary};
  --color-accent:${colors.accent};
  --color-background:${colors.background};
  --color-surface:${colors.surface ?? '#f8fafc'};
  --color-surface-hover:${colors.surface_hover && validColor(colors.surface_hover) ? colors.surface_hover : 'color-mix(in srgb,var(--color-surface) 92%,var(--color-text))'};
  --color-text:${colors.text};
  --color-text-light:${colors.text_light ?? '#64748b'};
  --font-heading:${withFallback(fonts.heading ?? 'Inter')};
  --font-body:${withFallback(fonts.body ?? 'Inter')};
  --font-mono:${fonts.mono ? fontFamilyCss(fonts.mono) : 'ui-monospace'};${roleFonts}
  ${designScalesCss(scales)}${fluid ? `\n  --type-rhythm:${typography.rhythm};\n  --measure-prose:${typography.line_length}ch;\n  --section-padding:var(--space-xl);\n  --spacing-xs:var(--space-xs);--spacing-sm:var(--space-sm);--spacing-md:var(--space-md);--spacing-lg:var(--space-lg);--spacing-xl:var(--space-xl);` : ''}
  --font-size-base:${fonts.size_base ?? 16}px;${v14 ? `\n  ${contentWidthsCss(settings.content_widths)}` : ''}
}${responsiveDesignScalesCss(scales, resolveBreakpointWidths(settings.responsive_breakpoints))}${fluid ? ':where([data-block=prose]){max-inline-size:var(--measure-prose)}' : ''}${fontSmoothingCss(fonts.smoothing, resolveRenderVersion(settings.render_version))}${v15 ? FONT_ROLE_CSS : ''}`;
}

/** Webfont families a site loads from Google Fonts (system families excluded). */
export function webFontFamilies(heading: string, body: string, mono?: string): string[] {
  return Array.from(new Set([heading, body, mono].filter((value): value is string => !!value && !isSystemFont(value))));
}

/** The Google Fonts stylesheet for these families, or null when only system fonts are used. */
export function googleFontsCssUrl(families: string[]): string | null {
  if (!families.length) return null;
  return `https://fonts.googleapis.com/css2?${families.map(family => `family=${encodeURIComponent(family)}:wght@400;500;600;700`).join('&')}&display=swap`;
}

export type FontDelivery = 'self_hosted' | 'google';
/**
 * How a published site delivers its webfonts. Self-hosted is the default: the
 * build copies the font files to the site's own origin, so a visitor's browser
 * never contacts Google before consent. `google` keeps the Google Fonts CDN.
 */
export function fontDelivery(fonts: { delivery?: unknown } | undefined): FontDelivery {
  return fonts?.delivery === 'google' ? 'google' : 'self_hosted';
}
/** Same-origin stylesheet a self-hosted publication links instead of Google Fonts. */
export const SELF_HOSTED_FONTS_CSS_PATH = '/_typeroll/fonts/fonts.css';
export const SELF_HOSTED_FONTS_DIRECTORY = '/_typeroll/fonts/';
const GSTATIC_URL = /url\((['"]?)(https:\/\/fonts\.gstatic\.com\/[^'")\s]+)\1\)/g;
/** Font file URLs in a Google Fonts stylesheet; only fonts.gstatic.com is accepted. */
export function googleFontFileUrls(css: string): string[] {
  return Array.from(new Set(Array.from(css.matchAll(GSTATIC_URL), match => match[2])));
}
/** Rewrite Google font file URLs to their same-origin copies; unknown URLs are dropped with their rule. */
export function rewriteGoogleFontCss(css: string, localPaths: Map<string, string>): string {
  const rules = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  return rules.flatMap(rule => {
    const urls = Array.from(rule.matchAll(GSTATIC_URL), match => match[2]);
    if (!urls.length || urls.some(url => !localPaths.has(url))) return [];
    return [rule.replace(GSTATIC_URL, (_, _quote, url) => `url(${localPaths.get(url)})`)];
  }).join('\n');
}

/**
 * CLS guard used while a webfont loads: a size-adjusted Arial stands in with
 * Inter-like metrics. Published pages and preview emit the same rule.
 */
/**
 * From render version 14 the fallback also has a bold face, so headings stay
 * bold while the webfont loads (before, headings skipped the fallback).
 */
export function webfontFallbackCss(renderVersion: number, plan?: FontPlan | null): string {
  if (renderVersion >= FONT_PLAN_RENDER_VERSION && plan) return `${webfontFallbackCss(14)}${fontFallbackFacesCss(plan)}`;
  return renderVersion >= 14
    ? `${WEBFONT_FALLBACK_CSS}@font-face{font-family:'tr-fallback';src:local('Arial Bold'),local('Arial-BoldMT');font-weight:600 900;size-adjust:107%;ascent-override:90%;descent-override:22%;line-gap-override:0%}`
    : WEBFONT_FALLBACK_CSS;
}

export const WEBFONT_FALLBACK_CSS = "@font-face{font-family:'tr-fallback';src:local('Arial');size-adjust:107%;ascent-override:90%;descent-override:22%;line-gap-override:0%}body{font-family:var(--font-body),'tr-fallback',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}h1,h2,h3,h4,h5,h6{font-family:var(--font-heading),'tr-fallback',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}";
