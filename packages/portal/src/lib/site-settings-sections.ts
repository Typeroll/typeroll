import type { SiteSettings } from '@typeroll/shared';

/** The form's scope is explicit: saving one section never resets another. */
export const SITE_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', description: 'Your site name, identity and icons.' },
  { id: 'design', label: 'Design', description: 'Colors, typography and rendering.' },
  { id: 'seo', label: 'SEO', description: 'Search visibility, sharing and structured data.' },
  { id: 'publishing', label: 'Publishing', description: 'Hosting, domains and preview addresses for this site.' },
  { id: 'integrations', label: 'Integrations', description: 'Modules, email and cookie consent.' },
  { id: 'access', label: 'Access & AI', description: 'Sharing, API access and guidance for your AI agents.' },
  { id: 'advanced', label: 'Advanced', description: 'Custom scripts, content exports and site lifecycle.' },
] as const;
export type SiteSettingsSection = typeof SITE_SETTINGS_SECTIONS[number]['id'];
export function isSiteSettingsSection(value: unknown): value is SiteSettingsSection {
  return SITE_SETTINGS_SECTIONS.some(section => section.id === value);
}
export const SITE_SETTINGS_SECTION_FIELDS: Record<SiteSettingsSection, readonly (keyof SiteSettings)[]> = {
  general: ['site_name', 'tagline', 'logo', 'favicon', 'apple_touch_icon', 'icon_192'],
  design: ['colors', 'fonts', 'typography', 'design_scales', 'responsive_breakpoints', 'image_sizes_default', 'header_behavior', 'date_format', 'content_widths', 'motion'],
  seo: ['default_seo_suffix', 'default_meta_description', 'default_og_image', 'language', 'time_zone', 'twitter_handle', 'organization', 'sitewide_noindex', 'sitewide_nofollow', 'seo_review', 'external_routes', 'robots_txt', 'ai_crawler_policy', 'trailing_slash'],
  publishing: [], // staging_url lives on the Site; domains have their own lifecycle.
  integrations: ['cookie_consent'],
  access: ['agent_instructions'],
  advanced: ['scripts_head', 'scripts_body_end', 'iframe_allowed_hosts'],
};
export function scopedSettings(next: SiteSettings, section: SiteSettingsSection): Partial<SiteSettings> {
  return Object.fromEntries(SITE_SETTINGS_SECTION_FIELDS[section].map(key => [key, next[key]]));
}

/** Sections a builder may save: the look and the identity of the site, no policy, publishing or code. */
export const DESIGN_SETTINGS_SECTIONS: readonly SiteSettingsSection[] = ['general', 'design'];
export function isDesignSettingsSection(section: SiteSettingsSection): boolean {
  return DESIGN_SETTINGS_SECTIONS.includes(section);
}
/** Settings keys a builder may change over the API: those of the design sections, the Site CSS and the render version. */
export const DESIGN_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  ...DESIGN_SETTINGS_SECTIONS.flatMap(section => SITE_SETTINGS_SECTION_FIELDS[section] as readonly string[]),
  'custom_css', 'render_version',
]);
