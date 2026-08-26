// Extract globally-applied styles from a WordPress site we're migrating.
//
// We look at three signals, in order of authority:
//   1. theme.json (Gutenberg themes): /wp-json/wp/v2/global-styles/...
//   2. Elementor kit colors/typography:  /wp-json/elementor/v1/globals
//   3. Heuristics on the rendered home page (computed via a regex sweep
//      over inline style attributes for the most common colors).
//
// The output is a partial SiteSettings the migration workflow merges into
// the new site's settings doc.

import type { SiteSettings } from '@typeroll/shared';
import { defaultSiteSettings } from '@typeroll/shared';

export type PartialColors = Partial<SiteSettings['colors']>;
export type PartialFonts = Partial<SiteSettings['fonts']>;
export interface PartialSettings {
  site_name?: string;
  tagline?: string;
  logo?: string;
  favicon?: string;
  colors: PartialColors;
  fonts: PartialFonts;
}

export async function extractGlobals(baseUrl: string): Promise<PartialSettings> {
  baseUrl = baseUrl.replace(/\/$/, '');
  const collected: PartialSettings = { colors: {}, fonts: {} };

  // Try Gutenberg global styles first.
  try {
    const res = await fetch(`${baseUrl}/wp-json/wp/v2/global-styles`, {
      headers: { 'User-Agent': 'Typeroll-Migrator/0.1' },
    });
    if (res.ok) {
      const gs = (await res.json()) as Array<{ styles?: ThemeJsonStyles }>;
      const styles = gs[0]?.styles;
      mergeFromThemeJson(collected, styles);
    }
  } catch {
    /* ignore */
  }

  // Try the active theme's theme.json directly.
  try {
    const res = await fetch(`${baseUrl}/wp-json/wp/v2/themes`, {
      headers: { 'User-Agent': 'Typeroll-Migrator/0.1' },
    });
    if (res.ok) {
      const themes = (await res.json()) as Array<{ theme_supports?: { 'editor-color-palette'?: Array<{ slug: string; color: string }> } }>;
      const palette = themes[0]?.theme_supports?.['editor-color-palette'];
      if (palette) mergeFromPalette(collected, palette);
    }
  } catch {
    /* ignore */
  }

  // Try Elementor kit.
  try {
    const res = await fetch(`${baseUrl}/wp-json/elementor/v1/globals`, {
      headers: { 'User-Agent': 'Typeroll-Migrator/0.1' },
    });
    if (res.ok) {
      const kit = (await res.json()) as ElementorGlobals;
      mergeFromElementor(collected, kit);
    }
  } catch {
    /* ignore */
  }

  // As a last resort, sniff the homepage HTML for the dominant brand color.
  if (!collected.colors?.primary) {
    try {
      const res = await fetch(`${baseUrl}/`, { headers: { 'User-Agent': 'Typeroll-Migrator/0.1' } });
      if (res.ok) {
        const html = await res.text();
        const sniffed = sniffDominantColor(html);
        if (sniffed) collected.colors.primary = sniffed;
      }
    } catch {
      /* ignore */
    }
  }

  return collected;
}

export function mergeSettings(
  base: SiteSettings,
  patch: PartialSettings & { site_name?: string; tagline?: string }
): SiteSettings {
  return {
    ...base,
    site_name: patch.site_name ?? base.site_name,
    tagline: patch.tagline ?? base.tagline,
    logo: patch.logo ?? base.logo,
    favicon: patch.favicon ?? base.favicon,
    colors: { ...base.colors, ...patch.colors },
    fonts: { ...base.fonts, ...patch.fonts },
  };
}

export function withDefaults(patch: PartialSettings): SiteSettings {
  return mergeSettings(defaultSiteSettings, patch);
}

// ─── Internals ────────────────────────────────────────────────────────────

interface ThemeJsonStyles {
  color?: { background?: string; text?: string; palette?: Array<{ slug: string; color: string }> };
  typography?: { fontFamily?: string; fontSize?: string };
  elements?: {
    h1?: { typography?: { fontFamily?: string } };
    button?: { color?: { background?: string } };
  };
}

function mergeFromThemeJson(into: PartialSettings, styles?: ThemeJsonStyles) {
  if (!styles) return;
  if (styles.color?.background) into.colors.background = styles.color.background;
  if (styles.color?.text) into.colors.text = styles.color.text;
  if (styles.elements?.button?.color?.background) {
    into.colors.primary = styles.elements.button.color.background;
  }
  if (styles.typography?.fontFamily) {
    into.fonts.body = stripFontFamily(styles.typography.fontFamily);
  }
  if (styles.elements?.h1?.typography?.fontFamily) {
    into.fonts.heading = stripFontFamily(styles.elements.h1.typography.fontFamily);
  }
  if (styles.color?.palette) mergeFromPalette(into, styles.color.palette);
}

function mergeFromPalette(into: PartialSettings, palette: Array<{ slug: string; color: string }>) {
  const colors = into.colors;
  for (const entry of palette) {
    const slug = entry.slug.toLowerCase();
    if (!colors.primary && (slug.includes('primary') || slug.includes('brand'))) colors.primary = entry.color;
    if (!colors.secondary && slug.includes('secondary')) colors.secondary = entry.color;
    if (!colors.accent && slug.includes('accent')) colors.accent = entry.color;
    if (!colors.background && slug.includes('background')) colors.background = entry.color;
    if (!colors.surface && (slug.includes('surface') || slug.includes('muted'))) colors.surface = entry.color;
    if (!colors.text && slug.includes('text') && !slug.includes('light')) colors.text = entry.color;
    if (!colors.text_light && slug.includes('light')) colors.text_light = entry.color;
  }
}

interface ElementorGlobals {
  colors?: {
    primary?: { value?: string };
    secondary?: { value?: string };
    text?: { value?: string };
    accent?: { value?: string };
  };
  typography?: {
    primary?: { font_family?: string };
    secondary?: { font_family?: string };
    text?: { font_family?: string };
  };
}

function mergeFromElementor(into: PartialSettings, kit: ElementorGlobals) {
  const c = into.colors;
  const f = into.fonts;
  if (kit.colors?.primary?.value) c.primary = kit.colors.primary.value;
  if (kit.colors?.secondary?.value) c.secondary = kit.colors.secondary.value;
  if (kit.colors?.accent?.value) c.accent = kit.colors.accent.value;
  if (kit.colors?.text?.value) c.text = kit.colors.text.value;
  if (kit.typography?.primary?.font_family) f.heading = kit.typography.primary.font_family;
  if (kit.typography?.secondary?.font_family) f.body = kit.typography.secondary.font_family;
  if (kit.typography?.text?.font_family && !f.body) f.body = kit.typography.text.font_family;
}

function stripFontFamily(s: string): string {
  // Often comes as `var(--wp--preset--font-family--foo)` or `"Inter", sans-serif`.
  // We pull the first quoted family or just keep the var name.
  const match = s.match(/['"]([^'"]+)['"]/);
  if (match) return match[1];
  if (s.startsWith('var(')) return 'Inter'; // can't resolve — default
  const first = s.split(',')[0].trim();
  return first || 'Inter';
}

function sniffDominantColor(html: string): string | null {
  // Very rough: tally hex colors in inline style attributes, return the most
  // common one that's not white/black/grey.
  const counts: Record<string, number> = {};
  const hexes = html.match(/#[0-9a-fA-F]{6}/g) ?? [];
  for (const hex of hexes) {
    const v = hex.toLowerCase();
    if (v === '#ffffff' || v === '#000000') continue;
    if (/^#([0-9a-f])\1\1$/i.test(v)) continue;
    counts[v] = (counts[v] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}
