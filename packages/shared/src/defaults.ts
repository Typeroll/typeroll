import type { SiteSettings } from './types.js';
import { LATEST_RENDER_VERSION } from './render-version.js';

export const defaultSiteSettings: SiteSettings = {
  site_name: 'New Site',
  tagline: '',
  colors: {
    primary: '#2563eb',
    secondary: '#1e293b',
    accent: '#f59e0b',
    background: '#ffffff',
    surface: '#f8fafc',
    text: '#0f172a',
    text_light: '#64748b',
  },
  fonts: {
    heading: 'Inter',
    body: 'Inter',
    size_base: 16,
  },
  language: 'en',
  default_seo_suffix: '',
  trailing_slash: 'always',
  robots_txt: 'User-agent: *\nAllow: /\n',
  render_version: LATEST_RENDER_VERSION,
};

/** Resolve a language tag using CLDR likely subtags, preserving an explicit region. */
export function ogLocale(language?: string): string {
  try {
    const locale = new Intl.Locale(language?.replaceAll('_', '-') || 'en');
    const region = locale.region || locale.maximize().region;
    if (region && /^[A-Z]{2}$/.test(region)) return `${locale.language}_${region}`;
  } catch { /* Invalid editor input must not emit an invalid OpenGraph locale. */ }
  return 'en_US';
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
