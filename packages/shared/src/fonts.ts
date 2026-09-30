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

/**
 * Theme tokens written into every page head from SiteSettings. Missing optional
 * values fall back so older settings documents never emit "undefined" CSS.
 * Published pages and preview emit the same block.
 */
export function siteThemeCss(settings: Pick<import('./types.js').SiteSettings, 'colors' | 'fonts'>): string {
  const colors = settings.colors ?? ({} as Partial<import('./types.js').SiteSettings['colors']>);
  const fonts = settings.fonts ?? ({} as Partial<import('./types.js').SiteSettings['fonts']>);
  return `:root{
  --color-primary:${colors.primary};
  --color-secondary:${colors.secondary};
  --color-accent:${colors.accent};
  --color-background:${colors.background};
  --color-surface:${colors.surface ?? '#f8fafc'};
  --color-text:${colors.text};
  --color-text-light:${colors.text_light ?? '#64748b'};
  --font-heading:${fontFamilyCss(fonts.heading ?? 'Inter')};
  --font-body:${fontFamilyCss(fonts.body ?? 'Inter')};
  --font-size-base:${fonts.size_base ?? 16}px;
}`;
}

/** Webfont families a site loads from Google Fonts (system families excluded). */
export function webFontFamilies(heading: string, body: string): string[] {
  return Array.from(new Set([heading, body].filter(value => value && !isSystemFont(value))));
}

/**
 * CLS guard used while a webfont loads: a size-adjusted Arial stands in with
 * Inter-like metrics. Published pages and preview emit the same rule.
 */
export const WEBFONT_FALLBACK_CSS = "@font-face{font-family:'tr-fallback';src:local('Arial');size-adjust:107%;ascent-override:90%;descent-override:22%;line-gap-override:0%}body{font-family:var(--font-body),'tr-fallback',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}h1,h2,h3,h4,h5,h6{font-family:var(--font-heading),'tr-fallback',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}";
