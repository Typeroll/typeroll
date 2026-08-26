import type { SiteSettings } from './types.js';

export const defaultSiteSettings: SiteSettings = {
  site_name: 'New Site',
  tagline: '',
  colors: {
    primary: '#3b82f6',
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
  robots_txt: 'User-agent: *\nAllow: /\n',
};

/**
 * Map a BCP 47 language tag to an OpenGraph locale (xx_XX). Best-effort —
 * defaults the region to an uppercased copy of the language code when no
 * explicit region is supplied (en → en_US is a special case Facebook docs
 * recommend).
 */
export function ogLocale(language?: string): string {
  if (!language) return 'en_US';
  const [lang, region] = language.split('-');
  if (region) return `${lang.toLowerCase()}_${region.toUpperCase()}`;
  if (lang.toLowerCase() === 'en') return 'en_US';
  return `${lang.toLowerCase()}_${lang.toUpperCase()}`;
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
